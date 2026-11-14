#!/usr/bin/env python3
"""Deploy an immutable bundle to the existing ERP stack, without rebuilding images."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import quote
from urllib.request import urlopen

ROOT = Path('/opt/erp')
PGDATA = '/var/lib/postgresql/data'
PROXY_IP = '172.18.0.5'
SPACE_RESERVE = 2 * 1024 ** 3
MIGRATION_CHECK = ('SELECT CASE WHEN count(*) = 1 AND bool_and(NOT dirty) '
                   'THEN 1 ELSE 0 END FROM schema_migrations')
SERVICES = ('db', 'erp', 'frontend', 'caddy', 'loki')
MOUNTS = {
    'db': {'/var/lib/postgresql/data': 'erp-infra_db_data'},
    'caddy': {'/data': 'erp-infra_caddy_data', '/config': 'erp-infra_caddy_config'},
    'loki': {'/loki': 'erp_loki_data'},
}
FILES = ('compose.yml', 'backend.yaml', 'Caddyfile', 'loki.yaml')
REQUIRED_ENV = ('DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD',
                'ADMIN_PASSWORD', 'JWT_SECRET_KEY')
VERSION = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
PRIVATE_DIAGNOSTICS = False
BOOTSTRAP = "import json,sys; p=json.load(sys.stdin); n={'__name__':'deploy_remote'}; exec(p.pop('driver'),n); n['receive'](p)"
STATUS = "import pathlib,sys; p=pathlib.Path('/opt/erp/.clockwork/requests')/sys.argv[1]/'status.json'; print(p.read_text() if p.is_file() else '{}')"


class DeployError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def safe_path(path):
    path = Path(path)
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise DeployError('Unexpected symbolic link in deployment path')
    return path


def directory(path, private=True):
    path = safe_path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700 if private else 0o755)
    if not path.is_dir():
        raise DeployError('Expected a deployment directory')
    if private:
        path.chmod(0o700)
    return path


def atomic_write(path, data, mode=0o600):
    path = safe_path(path)
    if path.exists() and not path.is_file():
        raise DeployError('Expected a regular deployment file')
    if path.exists() and path.read_bytes() == data:
        path.chmod(mode)
        return False
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(name, path)
        parent_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return True


def app_environment(raw):
    try:
        env = json.loads(raw)
    except (ValueError, TypeError):
        raise DeployError('DEPLOY_APP_ENV_JSON must be a JSON object') from None
    if not isinstance(env, dict) or set(env) - set((*REQUIRED_ENV, 'JWT_REFRESH_KEY')):
        raise DeployError('Unexpected application environment keys')
    for key in REQUIRED_ENV:
        if not isinstance(env.get(key), str) or not env[key]:
            raise DeployError('Missing application secret: ' + key)
    if any(not isinstance(v, str) or '\0' in v for v in env.values()):
        raise DeployError('Application environment values must be strings without NUL')
    if len(env['JWT_SECRET_KEY'].encode('utf-8')) < 32:
        raise DeployError('JWT_SECRET_KEY must contain at least 32 UTF-8 bytes')
    env.setdefault('JWT_REFRESH_KEY', '')
    env['DATABASE_URL'] = 'postgres://{}:{}@db:5432/{}?sslmode=disable'.format(
        quote(env['DATABASE_USER'], safe=''), quote(env['DATABASE_PASSWORD'], safe=''),
        quote(env['DATABASE_NAME'], safe=''))
    return env


def render(template, values):
    # JSON quoting keeps arbitrary secret characters inside a single YAML scalar.
    def replace(match):
        key = match[1]
        if key not in values:
            raise DeployError('Unknown deployment placeholder: ' + key)
        return json.dumps(str(values[key]).replace('$', '$$'))
    return re.sub(r'\$\{([A-Z_]+)\}', replace, template).encode()


def command(args, *, stdin=None, stdout=subprocess.PIPE, timeout=180):
    try:
        # Validated callers supply argv; shell metacharacters remain literal arguments.
        process = subprocess.Popen(args, stdin=stdin if hasattr(stdin, 'read') else subprocess.PIPE,  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                                   stdout=stdout, stderr=subprocess.PIPE, start_new_session=True, shell=False,
                                   env={k: v for k, v in os.environ.items() if not k.startswith('COMPOSE_')})
        try:
            output, errors = process.communicate(None if hasattr(stdin, 'read') else stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            # A surviving Compose plugin must not continue after the deployment lock is released.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            output, errors = process.communicate()
            raise subprocess.CalledProcessError(1, args, stderr=errors) from None
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args, stderr=errors)
    except (subprocess.CalledProcessError, OSError) as error:
        if PRIVATE_DIAGNOSTICS and getattr(error, 'stderr', None):
            sys.stderr.write(error.stderr.decode(errors='replace'))
        # Docker diagnostics may include interpolated credentials.
        raise DeployError('Command failed: ' + str(args[0]) + '; inspect the private server bundle') from None
    return output or b''


def docker_json(*args):
    try:
        return json.loads(command(['docker', *args]))
    except ValueError:
        raise DeployError('Invalid Docker response') from None


def compose(path, *args, stdin=None, stdout=subprocess.PIPE):
    safe_path(ROOT / '.env')
    return command(['docker', 'compose', '--project-name', 'erp', '--project-directory', str(ROOT),
                    '--env-file', str(ROOT / '.env') if (ROOT / '.env').is_file() else '/dev/null',
                    '-f', str(path), *args], stdin=stdin, stdout=stdout, timeout=600)


def inspect_stack(env):
    volumes = {}
    containers = {}
    for service in SERVICES:
        ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=erp',
                       '--filter', 'label=com.docker.compose.service=' + service]).decode().split()
        if len(ids) != 1:
            raise DeployError('Expected exactly one existing container for ' + service)
        container = docker_json('inspect', ids[0])[0]
        containers[service] = container
        for target, name in MOUNTS.get(service, {}).items():
            matches = [m for m in container['Mounts'] if m['Destination'] == target]
            if len(matches) != 1 or matches[0].get('Name') != name or matches[0]['Type'] != 'volume':
                raise DeployError('Existing persistent mount differs for ' + service)
            volume = docker_json('volume', 'inspect', name)[0]
            if volume.get('Driver') != 'local' or volume.get('Options'):
                raise DeployError('Unexpected persistent volume driver')
            volumes[name] = volume['Mountpoint']
        if 'erp_app-network' not in container['NetworkSettings']['Networks']:
            raise DeployError('Unexpected Docker network')
    network = docker_json('network', 'inspect', 'erp_app-network')[0]
    if network['IPAM']['Config'] != [{'Subnet': '172.18.0.0/16', 'Gateway': '172.18.0.1'}]:
        raise DeployError('Unexpected proxy network subnet')
    for peer_id, peer in network.get('Containers', {}).items():
        if peer.get('IPv4Address', '').split('/')[0] == PROXY_IP and peer_id != containers['caddy']['Id']:
            raise DeployError('The reserved reverse-proxy IP is occupied by another container')
    current_env = dict(item.split('=', 1) for item in containers['db']['Config']['Env'] if '=' in item)
    if current_env.get('PGDATA') != PGDATA:
        raise DeployError('Custom PGDATA requires a separate database migration')
    for key, app_key in [('POSTGRES_DB', 'DATABASE_NAME'), ('POSTGRES_USER', 'DATABASE_USER'),
                         ('POSTGRES_PASSWORD', 'DATABASE_PASSWORD')]:
        if current_env.get(key) != env[app_key]:
            raise DeployError('Database credential rotation requires a separate procedure: ' + app_key)
    backend_env = dict(item.split('=', 1) for item in containers['erp']['Config']['Env'] if '=' in item)
    if backend_env.get('JWT_REFRESH_KEY') and not env.get('JWT_REFRESH_KEY'):
        raise DeployError('Preserve the existing JWT_REFRESH_KEY in DEPLOY_APP_ENV_JSON')
    # Refuse to attach a different or empty PGDATA even when its name looks correct.
    command(['docker', 'exec', containers['db']['Id'], 'sh', '-c',
             'test "$(cat "$PGDATA/PG_VERSION")" = 16 && '
             'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
             '-Atc "' + MIGRATION_CHECK + '" | grep -qx 1'])
    return containers, volumes


def pinned_image(repository, version):
    if not VERSION.fullmatch(version):
        raise DeployError('Deploy versions must be canonical vX.Y.Z tags')
    tagged = repository + ':' + version
    command(['docker', 'pull', '--platform', 'linux/amd64', tagged], timeout=600)
    image = docker_json('image', 'inspect', tagged)[0]
    if image.get('Architecture') != 'amd64' or image.get('Os') != 'linux':
        raise DeployError('Application image must target linux/amd64')
    for ref in image.get('RepoDigests', []):
        repo, _, sha = ref.partition('@')
        if repo == repository and DIGEST.fullmatch(sha):
            return ref
    raise DeployError('Pulled image has no immutable repository digest')


def validate_model(model):
    if set(model['services']) != set(SERVICES):
        raise DeployError('The production service set must match the inventoried stack')
    if model['services']['db']['environment'].get('PGDATA') != PGDATA:
        raise DeployError('Candidate PGDATA must match the inventoried database directory')
    if model['services']['caddy']['networks'].get('app-network', {}).get('ipv4_address') != PROXY_IP:
        raise DeployError('The reverse proxy must retain its reserved IP')
    expected_volumes = {'db_data': 'erp-infra_db_data', 'caddy_data': 'erp-infra_caddy_data',
                        'caddy_config': 'erp-infra_caddy_config', 'loki_data': 'erp_loki_data'}
    if set(model['volumes']) != set(expected_volumes):
        raise DeployError('Unexpected production volumes')
    for key, name in expected_volumes.items():
        volume = model['volumes'][key]
        if volume.get('name') != name or volume.get('external') is not True:
            raise DeployError('Persistent volumes must remain external with their existing names')
    networks = model['networks']
    network = networks.get('app-network', {})
    if (model.get('name') != 'erp' or set(networks) != {'app-network'}
            or network.get('name') != 'erp_app-network' or network.get('external') is not True):
        raise DeployError('Production project and network must remain unchanged')
    config_targets = {'erp': '/app/config.yaml', 'frontend': '/usr/share/nginx/html/assets/custom',
                      'caddy': '/etc/caddy/Caddyfile', 'loki': '/etc/loki/loki.yaml'}
    repositories = {'db': 'postgres', 'erp': 'koshsky/erp-backend',
                    'frontend': 'koshsky/erp-frontend', 'caddy': 'caddy', 'loki': 'grafana/loki'}
    for name, service in model['services'].items():
        repo, _, sha = service['image'].partition('@')
        if repo != repositories[name] or not DIGEST.fullmatch(sha):
            raise DeployError('All production images must use their expected repository and immutable digest')
        if 'build' in service or set(service['networks']) != {'app-network'}:
            raise DeployError('Deployment must use existing images and the existing network')
        mounts = {m['target']: m for m in service.get('volumes', [])}
        expected_targets = set(MOUNTS.get(name, {})) | ({config_targets[name]} if name in config_targets else set())
        if set(mounts) != expected_targets or len(mounts) != len(service.get('volumes', [])):
            raise DeployError('Unexpected production mount targets')
        for target, volume_name in MOUNTS.get(name, {}).items():
            mount = mounts[target]
            source = mount.get('source')
            if mount['type'] != 'volume' or expected_volumes.get(source) != volume_name:
                raise DeployError('Persistent mount mapping must remain unchanged')
        if name in config_targets:
            mount = mounts[config_targets[name]]
            source = safe_path(mount['source'])
            if (mount['type'] != 'bind' or mount.get('read_only') is not True
                    or mount.get('bind', {}).get('create_host_path') is not False):
                raise DeployError('Configuration mounts must be read-only existing paths')
            if name == 'frontend':
                if source != ROOT / 'assets/custom':
                    raise DeployError('Custom assets must keep their existing path')
            elif ROOT / '.clockwork/configs' not in source.parents:
                raise DeployError('Configuration must come from the deployment bundle')


def backup_sources(containers):
    sources = [(safe_path(ROOT / name), name) for name in
               ('docker-compose.yml', '.env', 'config.yaml', 'caddy', 'loki', 'assets')
               if (ROOT / name).exists()]
    for service, container in containers.items():
        for index, mount in enumerate(container['Mounts']):
            if mount['Type'] == 'bind' and mount['Destination'] != '/usr/share/nginx/html/assets/custom':
                sources.append((safe_path(mount['Source']), f'binds/{service}/{index}'))
    return sources


def archive_size(path):
    path = safe_path(path)
    total = 1024 + path.lstat().st_size
    if path.is_dir():
        for parent, dirs, files in os.walk(path, followlinks=False):
            for name in (*dirs, *files):
                total += 2048 + (Path(parent) / name).lstat().st_size
    return total


def backup_budget(containers, volumes, database_size):
    ancillary = sum(archive_size(path) for path, _ in backup_sources(containers))
    ancillary += sum(archive_size(volumes['erp-infra_caddy_' + target]) for target in ('data', 'config'))
    return SPACE_RESERVE + 2 * (database_size + ancillary) + 16 * 1024 ** 2


class BackupWriter:
    def __init__(self, stream):
        self.stream = stream

    def write(self, data):
        if shutil.disk_usage(ROOT).free < SPACE_RESERVE + len(data):
            raise DeployError('Backup stopped to preserve free space for running services')
        return self.stream.write(data)

    def flush(self):
        self.stream.flush()


def backup(active, destination, containers, volumes):
    directory(destination)
    with (destination / 'database.dump').open('xb') as stream:
        compose(active, 'exec', '-T', 'db', 'sh', '-c',
                'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc', stdout=stream)
    with (destination / 'database.dump').open('rb') as stream:
        compose(active, 'exec', '-T', 'db', 'pg_restore', '--list', stdin=stream, stdout=subprocess.DEVNULL)
    archives = [('configuration.tar.gz', backup_sources(containers))]
    archives += [('caddy-' + target + '.tar.gz', [(safe_path(volumes['erp-infra_caddy_' + target]), '.')])
                 for target in ('data', 'config')]
    for filename, sources in archives:
        with (destination / filename).open('xb') as stream:
            with tarfile.open(fileobj=BackupWriter(stream), mode='w|gz') as archive:
                for source, name in sources:
                    archive.add(source, arcname=name)
    atomic_write(destination / 'complete', b'verified dump archive\n')


def resolve_images(plan_file, payload):
    images = json.loads(plan_file.read_text()) if plan_file.exists() else {}
    for key, repo, version in (('BACKEND_IMAGE', 'koshsky/erp-backend', 'backend'),
                               ('FRONTEND_IMAGE', 'koshsky/erp-frontend', 'frontend')):
        if key not in images:
            images[key] = pinned_image(repo, payload[version])
            atomic_write(plan_file, encoded(images))
    return images


def wait_loki(image):
    deadline = time.monotonic() + 180
    while True:
        try:
            command(['docker', 'run', '--rm', '--network', 'erp_app-network', '--read-only',
                     '--entrypoint', '/usr/bin/curl', image, '--fail', '--silent', '--show-error',
                     '--max-time', '5', 'http://loki:3100/ready'], timeout=10)
            return
        except DeployError:
            if time.monotonic() >= deadline:
                raise DeployError('Loki readiness failed; application traffic remains paused when required') from None
            time.sleep(2)


def loki_changes(candidate, containers):
    parts = compose(candidate, 'config', '--hash', 'loki').decode().split()
    if len(parts) != 2 or parts[0] != 'loki' or not re.fullmatch(r'[0-9a-f]{64}', parts[1]):
        raise DeployError('Cannot determine the Loki configuration hash')
    return parts[1] != containers['loki']['Config']['Labels'].get('com.docker.compose.config-hash')


def ready(active, model):
    wait_loki(model['services']['caddy']['image'])
    compose(active, 'exec', '-T', 'db', 'sh', '-c',
            'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
            '-Atc "' + MIGRATION_CHECK + '" | grep -qx 1')
    for url in ('https://erp.koshsky.ru/api/v1/health', 'https://erp.koshsky.ru/'):
        for attempt in range(12):
            try:
                with urlopen(url, timeout=10) as response:
                    data = response.read(1048576)
                    if response.status != 200 or (b'"ok"' not in data if url.endswith('health')
                                                  else b'<html' not in data.lower()):
                        raise DeployError('Unexpected public HTTP response')
                break
            except Exception:
                if attempt == 11:
                    raise DeployError('Public HTTPS readiness failed') from None
                time.sleep(5)


def runtime_ready(containers):
    return all(c['State']['Running']
               and c['State'].get('Health', {}).get('Status', 'healthy') == 'healthy'
               for c in containers.values())


def runtime_signature(containers):
    return {name: {'id': c['Id'], 'image': c['Image'],
                   'config': c['Config']['Labels'].get('com.docker.compose.config-hash')}
            for name, c in containers.items()}


def apply(request):
    request = safe_path(request)
    if request.parent != ROOT / '.clockwork/requests' or not re.fullmatch(r'[0-9a-f]{64}', request.name):
        raise DeployError('Invalid server request path')
    payload = json.loads((request / 'payload.json').read_text())
    status = {'phase': 'preflight', 'request': request.name, 'source': payload['source']}
    def phase(name):
        status['phase'] = name
        atomic_write(request / 'status.json', encoded(status))
    try:
        state = directory(ROOT / '.clockwork')
        with safe_path(state / 'deploy.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeployError('Another server deployment is running') from None
            env = app_environment(payload['environment'])
            active = safe_path(ROOT / 'docker-compose.yml')
            if not active.is_file():
                raise DeployError('Existing server Compose is required; bootstrap is not a deploy')
            if shutil.disk_usage(ROOT).free < SPACE_RESERVE:
                raise DeployError('At least 2 GiB of free disk is required')
            containers, volumes = inspect_stack(env)
            assets = directory(ROOT / 'assets' / 'custom', private=False)
            values = dict(env, CUSTOM_ASSETS=str(assets))
            for name, key in [('backend.yaml', 'BACKEND_CONFIG'), ('Caddyfile', 'CADDY_CONFIG'),
                              ('loki.yaml', 'LOKI_CONFIG')]:
                content = payload['files'][name].encode()
                config_dir = directory(state / 'configs' / digest(content))
                config_path = config_dir / name
                atomic_write(config_path, content, 0o644)
                values[key] = str(config_path)
            phase('pull')
            images = resolve_images(request / 'images.json', payload)
            values.update(images)
            candidate = request / 'compose.yml'
            atomic_write(candidate, render(payload['files']['compose.yml'], values))
            phase('validate')
            model = json.loads(compose(candidate, 'config', '--format', 'json'))
            validate_model(model)
            applied_file = safe_path(state / 'applied.json')
            applied = json.loads(applied_file.read_text()) if applied_file.exists() else {}
            if (active.read_bytes() == candidate.read_bytes()
                    and applied.get('containers') == runtime_signature(containers)
                    and runtime_ready(containers)):
                status['images'] = images
                ready(active, model)
                phase('succeeded')
                return
            # Pull and validate before touching the running stack or its active files.
            compose(candidate, 'pull')
            postgres_image = docker_json('image', 'inspect', model['services']['db']['image'])[0]
            if 'PG_MAJOR=16' not in postgres_image['Config']['Env']:
                raise DeployError('PostgreSQL major upgrades require a separate procedure')
            command(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                     '--mount', 'type=bind,source=' + values['CADDY_CONFIG'] +
                     ',target=/etc/caddy/Caddyfile,readonly',
                     model['services']['caddy']['image'], 'caddy', 'validate',
                     '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])
            command(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                     '--mount', 'type=bind,source=' + values['LOKI_CONFIG'] +
                     ',target=/etc/loki/loki.yaml,readonly', model['services']['loki']['image'],
                     '-config.file=/etc/loki/loki.yaml', '-querier.split-queries-by-interval=24h',
                     '-verify-config=true'])
            database_size = int(command(['docker', 'exec', containers['db']['Id'], 'sh', '-c',
                'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                '-Atc "SELECT pg_database_size(current_database())"']))
            if shutil.disk_usage(ROOT).free < backup_budget(containers, volumes, database_size):
                raise DeployError('Insufficient disk space for database and ancillary backups plus reserve')
            phase('backup')
            backup_dir = directory(state / 'backups') / (request.name + '-' + str(time.time_ns()))
            backup(active, backup_dir, containers, volumes)
            status['backup'] = str(backup_dir)
            status['images'] = images
            previous = safe_path(request / 'previous-compose.yml')
            if not previous.exists():
                atomic_write(previous, active.read_bytes())
            if loki_changes(candidate, containers):
                phase('pause-traffic')
                compose(active, 'stop', '--timeout', '30', 'caddy')
                compose(active, 'stop', '--timeout', '30', 'erp')
            phase('apply')
            atomic_write(active, candidate.read_bytes())
            compose(active, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'db', 'loki')
            phase('wait-audit')
            wait_loki(model['services']['caddy']['image'])
            compose(active, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180')
            phase('verify')
            current, _ = inspect_stack(env)
            if current['caddy']['NetworkSettings']['Networks']['erp_app-network'].get('IPAddress') != PROXY_IP:
                raise DeployError('Running reverse proxy does not use its reserved IP')
            if not runtime_ready(current):
                raise DeployError('A required service is not running or healthy')
            for service, key in [('erp', 'BACKEND_IMAGE'), ('frontend', 'FRONTEND_IMAGE')]:
                expected = docker_json('image', 'inspect', images[key])[0]['Id']
                if current[service]['Image'] != expected:
                    raise DeployError('Running application image does not match the deployment digest')
            ready(active, model)
            atomic_write(applied_file, encoded({'containers': runtime_signature(current),
                                               'source': payload['source'], 'images': images}))
            phase('succeeded')
    except Exception as error:
        status['error'] = str(error) if isinstance(error, DeployError) else 'Internal deployment error'
        phase('failed')
        raise


def receive(payload):
    os.umask(0o077)
    # Both staging and execution are confined to the previously inventoried stack.
    directory(ROOT, private=False)
    state = directory(ROOT / '.clockwork')
    requests = directory(state / 'requests')
    identifier = digest(encoded(payload))
    request = directory(requests / identifier)
    with safe_path(request / 'start.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        payload_file = request / 'payload.json'
        atomic_write(payload_file, encoded(payload))
        script = request / 'deploy.py'
        # The receiver's source is supplied explicitly; no shell interpolation is used.
        atomic_write(script, base64.b64decode(payload['script']))
        status_path = safe_path(request / 'status.json')
        pid_file = safe_path(request / 'pid')
        pid = int(pid_file.read_text()) if pid_file.exists() else None
        running = False
        if pid:
            try:
                os.kill(pid, 0)
                cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                running = str(script).encode() in cmdline and str(request).encode() in cmdline
            except (ProcessLookupError, FileNotFoundError):
                pass
        if not running:
            atomic_write(status_path, encoded({'phase': 'starting'}))
            with (request / 'private.log').open('ab') as log:
                # Content-hash paths are private local files, passed as argv rather than shell source.
                child = subprocess.Popen([sys.executable, str(script), 'apply', str(request)],  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                                         stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                         start_new_session=True, close_fds=True, shell=False)
            # The worker owns status.json; the PID is separate to avoid a startup race.
            atomic_write(request / 'pid', str(child.pid).encode())
    print(identifier, flush=True)


def ssh_command(env, key, known_hosts):
    host = env.get('DEPLOY_HOST', '')
    user = env.get('DEPLOY_USER', '')
    port = env.get('DEPLOY_PORT', '22') or '22'
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', host) or user != 'root':
        raise DeployError('Configure DEPLOY_HOST and DEPLOY_USER=root')
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise DeployError('Invalid DEPLOY_PORT')
    return ['ssh', '-F', '/dev/null', '-i', str(key), '-p', port,
            '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known_hosts),
            '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3', user + '@' + host]


def deploy():
    env = os.environ
    app_environment(env.get('DEPLOY_APP_ENV_JSON', ''))
    source = env.get('GITHUB_SHA', '')
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise DeployError('A committed Git source SHA is required')
    repo = Path(__file__).resolve().parent.parent
    versions = {
        'backend': env.get('BACKEND_VERSION') or 'v' + (repo / 'backend/VERSION').read_text().strip(),
        'frontend': env.get('FRONTEND_VERSION') or 'v' + json.loads((repo / 'frontend/package.json').read_text())['version'],
    }
    if any(not VERSION.fullmatch(v) for v in versions.values()):
        raise DeployError('Use canonical published vX.Y.Z versions')
    payload = dict(versions, source=source, environment=env['DEPLOY_APP_ENV_JSON'],
                   script=base64.b64encode(Path(__file__).read_bytes()).decode(),
                   files={name: (repo / 'deploy/production' / name).read_text() for name in FILES})
    with tempfile.TemporaryDirectory(prefix='clockwork-ssh-') as tmp:
        key, hosts = Path(tmp).resolve() / 'key', Path(tmp).resolve() / 'known_hosts'
        for path, secret in [(key, 'DEPLOY_SSH_KEY'), (hosts, 'DEPLOY_KNOWN_HOSTS')]:
            if not env.get(secret, '').strip():
                raise DeployError('Missing GitHub environment secret: ' + secret)
            atomic_write(path, (env[secret].rstrip() + '\n').encode())
        ssh = ssh_command(env, key, hosts)
        packet = dict(payload, driver=Path(__file__).read_text())
        identifier = digest(encoded(payload))
        print('Server deployment: ' + identifier, flush=True)
        # A lost acknowledgement does not imply that the detached worker did not start.
        try:
            reply = command([*ssh, 'python3 -c ' + shlex.quote(BOOTSTRAP)],
                            stdin=encoded(packet), timeout=90).decode().strip()
        except DeployError:
            print('Start acknowledgement unavailable; checking the known server request.', flush=True)
        else:
            if reply != identifier:
                raise DeployError('Invalid remote deployment ID')
        previous = None
        deadline = time.monotonic() + 25 * 60
        while time.monotonic() < deadline:
            try:
                state = json.loads(command([*ssh, 'python3 -c ' + shlex.quote(STATUS) + ' ' + identifier], timeout=30))
            except (DeployError, ValueError):
                time.sleep(5)
                continue
            phase = state.get('phase')
            if phase != previous:
                print('Deployment phase: ' + str(phase), flush=True)
                previous = phase
            if phase == 'succeeded':
                print('Deployed immutable images: ' + json.dumps(state['images']), flush=True)
                return
            if phase == 'failed':
                raise DeployError(state.get('error', 'Remote deployment failed'))
            time.sleep(5)
        raise DeployError('Stopped waiting; the server worker may still be running. Inspect its status before retrying.')


def main():
    global PRIVATE_DIAGNOSTICS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('deploy', 'apply'))
    parser.add_argument('request', nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'apply':
        PRIVATE_DIAGNOSTICS = True
        if not args.request:
            raise DeployError('Missing server request directory')
        apply(Path(args.request))
    else:
        deploy()


if __name__ == '__main__':
    try:
        main()
    except DeployError as error:
        print('ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
