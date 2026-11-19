#!/usr/bin/env python3
"""Optional, local, read-only demo observations; no schedules or notifications."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import sys
import time

SERVICES = ('db', 'erp', 'frontend', 'caddy', 'loki')
DISKS = ('application', 'docker', 'database', 'audit', 'backups')
PHASES = ('preflight', 'pull', 'validate', 'backup', 'pause-traffic', 'apply',
          'wait-audit', 'verify', 'succeeded', 'failed')
SHA = re.compile(r'[0-9a-f]{64}\Z')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
VERSION = r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
LIMIT = 128 * 1024


class ObservationError(Exception):
    pass


def read_file(path, limit=LIMIT):
    path = Path(path)
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ObservationError('unsafe_path')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ObservationError('not_regular')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ObservationError('oversized')
    return data


def decode_json(raw):
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        raise ObservationError('invalid_json') from None
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > 16:
            raise ObservationError('json_depth')
        children = item.values() if isinstance(item, dict) else item if isinstance(item, list) else ()
        pending.extend((child, depth + 1) for child in children if isinstance(child, (dict, list)))
    return value


def read_json(path):
    return decode_json(read_file(path))


def number(value):
    return type(value) in (int, float) and 0 <= value <= 2 ** 63 - 1 and math.isfinite(value)


def validate(config):
    allowed = {'enabled', 'root', 'project', 'containers', 'disks', 'tls', 'limits'}
    if not isinstance(config, dict) or set(config) - allowed:
        raise ObservationError('invalid_config')
    if type(config.get('enabled', False)) is not bool:
        raise ObservationError('invalid_config')
    if not isinstance(config.get('root'), str) or not Path(config['root']).is_absolute():
        raise ObservationError('invalid_config')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', config.get('project', '')):
        raise ObservationError('invalid_config')
    containers = config.get('containers', {})
    if not isinstance(containers, dict) or set(containers) - set(SERVICES):
        raise ObservationError('invalid_config')
    for value in containers.values():
        if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', value):
            raise ObservationError('invalid_config')
    disks = config.get('disks', {})
    if not isinstance(disks, dict) or set(disks) - set(DISKS):
        raise ObservationError('invalid_config')
    if any(not isinstance(p, str) or not Path(p).is_absolute() for p in disks.values()):
        raise ObservationError('invalid_config')
    limits = config.get('limits', {})
    names = {'min_available_memory_bytes', 'min_available_disk_bytes', 'min_available_inodes',
             'min_tls_remaining_seconds', 'max_backup_age_seconds', 'max_restore_age_seconds',
             'max_deploy_age_seconds'}
    if not isinstance(limits, dict) or set(limits) - names:
        raise ObservationError('invalid_config')
    if any(v is not None and not number(v) for v in limits.values()):
        raise ObservationError('invalid_config')
    tls = config.get('tls')
    if tls is not None:
        if (not isinstance(tls, dict) or set(tls) != {'host', 'port'}
                or not isinstance(tls['host'], str)
                or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}', tls['host'])
                or type(tls['port']) is not int or not 1 <= tls['port'] <= 65535):
            raise ObservationError('invalid_config')
    return config


def threshold(value, limit, minimum=True):
    if limit is None:
        return 'observed'
    return 'ok' if (value >= limit if minimum else value <= limit) else 'failed'


def observe(function, *args):
    try:
        return function(*args)
    except (OSError, ValueError, KeyError, TypeError, ObservationError, subprocess.SubprocessError):
        # Never serialize raw stderr, paths, exception messages or deployment errors.
        return {'status': 'unknown'}


def memory(limits, path='/proc/meminfo'):
    fields = {}
    for line in read_file(path).decode('ascii').splitlines():
        match = re.fullmatch(r'(MemTotal|MemAvailable):\s+(\d+) kB', line)
        if match:
            fields[match[1]] = int(match[2]) * 1024
    available, total = fields['MemAvailable'], fields['MemTotal']
    if not 0 <= available <= total or total <= 0:
        raise ObservationError('invalid_memory')
    return {'status': threshold(available, limits.get('min_available_memory_bytes')),
            'available_bytes': available, 'total_bytes': total}


def disk(path, limits):
    info = os.statvfs(path)
    available = info.f_bavail * info.f_frsize
    inodes = info.f_favail
    if available < 0 or inodes < 0:
        raise ObservationError('invalid_disk')
    return {'status': threshold(available, limits.get('min_available_disk_bytes')),
            'available_bytes': available, 'total_bytes': info.f_blocks * info.f_frsize,
            'inodes': {'status': threshold(inodes, limits.get('min_available_inodes'))
                       if info.f_files else 'unknown', 'available': inodes}}


def docker_json(*args):
    # Temporary files bound memory even if the local daemon returns excessive data.
    # The selected fields exclude Config.Env, health logs and mounts entirely.
    import tempfile
    with tempfile.TemporaryFile() as output:
        subprocess.run(['docker', *args], stdout=output, stderr=subprocess.DEVNULL,
                       check=True, timeout=5)
        output.seek(0)
        raw = output.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ObservationError('oversized')
    return decode_json(raw)


def container(name, service, project):
    template = ('{"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                '"container_id":{{json .Id}},"running":{{json .State.Running}},"image":{{json .Image}},'
                '"restarts":{{json .RestartCount}},'
                '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}')
    item = docker_json('container', 'inspect', '--format', template, name)
    if (not isinstance(item, dict) or item['project'] != project or item['service'] != service
            or not SHA.fullmatch(item['container_id'])
            or type(item['running']) is not bool or not IMAGE.fullmatch(item['image'])
            or type(item['restarts']) is not int or item['restarts'] < 0
            or item['health'] not in (None, 'healthy', 'unhealthy', 'starting')):
        raise ObservationError('wrong_stack_or_state')
    result = {'status': 'failed' if not item['running'] or item['health'] in ('unhealthy', 'starting') else 'ok',
              'running': item['running'], 'health': item['health'] or 'not_configured',
              'restart_count': item['restarts'], 'image_id': item['image']}
    if service == 'db' and item['health'] is None and item['running']:
        result['status'] = 'unknown'
    if service in ('erp', 'frontend'):
        tags = observe(image_tags, item['image'], service)
        result['version_metadata'] = tags
        result['release'] = observe(runtime_version, item['container_id'], service)
    return result


def runtime_version(container_id, service):
    if service == 'erp':
        data = docker_json('exec', container_id, 'wget', '-q', '-T', '2', '-O', '-',
                           'http://127.0.0.1:8080/api/v1/about')['data']
    elif service == 'frontend':
        data = docker_json('exec', container_id, 'cat', '/usr/share/nginx/html/build-target.json')
        if not isinstance(data, dict) or data.get('protocol') != 1 or data.get('target') != 'web':
            raise ObservationError('invalid_renderer_metadata')
    else:
        raise ObservationError('unsupported_version')
    if not isinstance(data, dict):
        raise ObservationError('invalid_version_metadata')
    version = data['version']
    if not isinstance(version, str) or len(version) > 127 or not re.fullmatch('v?' + VERSION[1:], version):
        raise ObservationError('invalid_version')
    return {'status': 'ok', 'version': version.removeprefix('v')}


def image_tags(image, service):
    tags = docker_json('image', 'inspect', '--format', '{{json .RepoTags}}', image)
    repo = 'koshsky/erp-' + ('backend' if service == 'erp' else 'frontend')
    if tags is not None and not isinstance(tags, list):
        raise ObservationError('invalid_tags')
    versions = sorted({t.split(':')[1] for t in tags or [] if isinstance(t, str)
                       and re.fullmatch(re.escape(repo) + ':' + VERSION, t)})
    return {'status': 'ok' if versions else 'unknown', 'local_version_tags': versions}


def tls_expiry(target, limits, now):
    if target is None:
        return {'status': 'not_configured'}
    # No HTTP request, credentials, bypass of verification, or public listener.
    with socket.create_connection((target['host'], target['port']), timeout=3) as sock:
        with ssl.create_default_context().wrap_socket(sock, server_hostname=target['host']) as secure:
            expiry = ssl.cert_time_to_seconds(secure.getpeercert()['notAfter'])
    remaining = int(expiry - now)
    return {'status': 'failed' if remaining <= 0 else threshold(remaining, limits.get('min_tls_remaining_seconds')),
            'remaining_seconds': remaining}


def candidates(directory, pattern):
    if any(p.is_symlink() for p in (directory, *directory.parents)):
        raise ObservationError('unsafe_path')
    result = []
    with os.scandir(directory) as entries:
        for index, entry in enumerate(entries):
            if index >= 1000:
                raise ObservationError('inventory_limit')
            if re.fullmatch(pattern, entry.name) and entry.is_dir(follow_symlinks=False):
                result.append(Path(entry.path))
    return result


def deployment(root, limits, now):
    paths = candidates(root / '.clockwork/requests', r'[0-9a-f]{64}')
    if not paths:
        return {'status': 'unknown'}
    # A new request without a status may be stalled before preflight; include it.
    latest = max(paths, key=lambda p: p.stat().st_mtime_ns)
    path = latest / 'status.json'
    item = read_json(path)
    if not isinstance(item, dict) or item.get('request') != latest.name or item.get('phase') not in PHASES:
        raise ObservationError('invalid_deploy')
    age = now - path.stat().st_mtime
    if age < 0:
        raise ObservationError('future_status')
    phase = item['phase']
    state = 'failed' if phase == 'failed' else 'ok' if phase == 'succeeded' else 'in_progress'
    if phase not in ('failed', 'succeeded') and limits.get('max_deploy_age_seconds') is not None:
        state = threshold(age, limits['max_deploy_age_seconds'], minimum=False)
        if state == 'ok':
            state = 'in_progress'
    return {'status': state, 'phase': phase, 'age_seconds': int(age)}


def restore_evidence(directory, dump, limits, now, verify):
    item = decode_json(read_file(directory / 'restore-test.json', 1024))
    if (not isinstance(item, dict) or set(item) != {'schema', 'dump_sha256', 'restored_at', 'result'}
            or type(item['schema']) is not int or item['schema'] != 1
            or item['result'] != 'restored_and_checked' or not isinstance(item['dump_sha256'], str)
            or not SHA.fullmatch(item['dump_sha256'])):
        raise ObservationError('invalid_restore_evidence')
    stamp = item['restored_at']
    if not isinstance(stamp, str) or not stamp.endswith('Z'):
        raise ObservationError('invalid_restore_date')
    when = dt.datetime.fromisoformat(stamp).timestamp()
    age = now - when
    if age < 0 or when < dump.stat().st_mtime:
        raise ObservationError('invalid_restore_date')
    age_state = threshold(age, limits.get('max_restore_age_seconds'), minimum=False)
    result = {'status': 'failed' if age_state == 'failed' else 'recorded',
              'age_seconds': int(age), 'digest_checked': False,
              'restored_at': dt.datetime.fromtimestamp(when, dt.timezone.utc).isoformat()}
    if verify:
        # Explicit manual check: large dumps are never hashed during routine polling.
        digest = hashlib.sha256()
        fd = os.open(dump, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ObservationError('unsafe_dump')
            deadline = time.monotonic() + 30
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                if time.monotonic() > deadline:
                    raise ObservationError('hash_deadline')
            after = os.fstat(stream.fileno())
        current = dump.lstat()
        if ((before.st_ino, before.st_size, before.st_mtime_ns) != (current.st_ino, current.st_size, current.st_mtime_ns)
                or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns)
                or digest.hexdigest() != item['dump_sha256']):
            return {'status': 'failed', 'digest_checked': False}
        result.update(status=age_state, digest_checked=True)
        result['evidence'] = 'operator_attested_restore'
    return result


def backup_record(directory, limits, now):
    dump = directory / 'database.dump'
    info = dump.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ObservationError('unsafe_dump')
    age = now - info.st_mtime
    if age < 0:
        raise ObservationError('future_dump')
    result = {'status': 'incomplete', 'dump_present': True, 'size_bytes': info.st_size,
              'age_seconds': int(age), 'catalog_check': 'unknown'}
    try:
        complete = read_file(directory / 'complete', 64) == b'verified dump archive\n'
    except (OSError, ObservationError):
        complete = False
    if info.st_size > 0 and complete:
        result.update(status=threshold(age, limits.get('max_backup_age_seconds'), minimum=False),
                      catalog_check='verified_at_creation')
    return result


def backups(root, limits, now, verify):
    paths = sorted(candidates(root / '.clockwork/backups', r'[0-9a-f]{64}-[0-9]{1,20}'),
                   key=lambda p: int(p.name.rsplit('-', 1)[1]), reverse=True)
    result = {'latest_attempt': {'status': 'unknown'}, 'latest_completed': {'status': 'unknown'},
              'last_restore': {'status': 'unknown'}}
    restored = None
    for index, path in enumerate(paths):
        record = observe(backup_record, path, limits, now)
        if index == 0:
            result['latest_attempt'] = record
        if record.get('catalog_check') != 'verified_at_creation':
            continue
        if result['latest_completed']['status'] == 'unknown':
            result['latest_completed'] = record
        evidence = observe(restore_evidence, path, path / 'database.dump', limits, now, False)
        if 'restored_at' in evidence:
            when = dt.datetime.fromisoformat(evidence['restored_at']).timestamp()
            if restored is None or when > restored[0]:
                restored = (when, path)
                result['last_restore'] = evidence
    if verify and restored is not None:
        path = restored[1]
        result['last_restore'] = observe(restore_evidence, path, path / 'database.dump', limits, now, True)
    return result


def collect(config, verify=False):
    limits, now = config.get('limits', {}), time.time()
    root = Path(config['root'])
    return {'schema': 1, 'checked_at': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(),
            'memory': observe(memory, limits),
            'disks': {name: observe(disk, config['disks'][name], limits)
                      if name in config.get('disks', {}) else {'status': 'not_configured'} for name in DISKS},
            'services': {name: observe(container, config['containers'][name], name, config['project'])
                         if name in config.get('containers', {}) else {'status': 'not_configured'} for name in SERVICES},
            'tls': observe(tls_expiry, config.get('tls'), limits, now),
            'deploy': observe(deployment, root, limits, now),
            'backup': observe(backups, root, limits, now, verify)}


def exit_code(value):
    states = []
    def visit(item):
        if isinstance(item, dict):
            if 'status' in item:
                states.append(item['status'])
            for child in item.values():
                visit(child)
    visit(value)
    return 1 if 'failed' in states or 'incomplete' in states else 2 if any(s != 'ok' for s in states) else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--verify-restore-evidence', action='store_true',
                        help='manually hash the latest dump (30-second budget); never restores a database')
    args = parser.parse_args(argv)
    try:
        config = validate(read_json(args.config))
        report = collect(config, args.verify_restore_evidence) if config.get('enabled', False) else {'status': 'not_configured'}
    except (OSError, ValueError, TypeError, ObservationError):
        report = {'status': 'unknown', 'reason': 'invalid_or_unreadable_config'}
    print(json.dumps(report, sort_keys=True))
    return exit_code(report)


if __name__ == '__main__':
    sys.exit(main())
