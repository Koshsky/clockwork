#!/usr/bin/env python3
"""Optional local demo alert evaluation; no built-in network delivery or schedule."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import stat
import tempfile
import time

SIGNALS = ('external_readiness', 'database', 'disk', 'tls')
DISKS = ('application', 'docker', 'database', 'audit', 'backups')


def timestamp(value):
    try:
        if isinstance(value, str):
            value = dt.datetime.fromisoformat(value).timestamp()
        return float(value) if type(value) in (int, float) and 0 <= value < 8640000000000 else None
    except (ValueError, OverflowError):
        return None


def validate(config):
    if not isinstance(config, dict) or type(config.get('enabled')) is not bool:
        raise ValueError('invalid_config')
    if not config['enabled']:
        return config
    if set(config) != {'enabled', 'debounce_samples', 'stale_after_seconds', 'tls_min_seconds', 'disks'}:
        raise ValueError('invalid_policy')
    if type(config['debounce_samples']) is not int or not 1 <= config['debounce_samples'] <= 60:
        raise ValueError('invalid_debounce')
    for key in ('stale_after_seconds', 'tls_min_seconds'):
        if type(config[key]) not in (int, float) or not 0 < config[key] <= 365 * 86400:
            raise ValueError('explicit_policy_required')
    if (not isinstance(config['disks'], list) or not 1 <= len(config['disks']) <= len(DISKS)
            or any(d not in DISKS for d in config['disks'])):
        raise ValueError('explicit_disks_required')
    return config


def observations(host, external, policy, now):
    def fresh(item):
        stamp = timestamp(item.get('checked_at'))
        return stamp is not None and 0 <= now - stamp <= policy['stale_after_seconds']
    def status(value):
        return 'ok' if value == 'ok' else 'bad' if value in ('failed', 'incomplete') else 'unknown'
    signals = {name: 'unknown' for name in SIGNALS}
    if fresh(external):
        signals['external_readiness'] = status(external.get('status'))
        tls = external.get('tls', {})
        seconds = tls.get('remaining_seconds')
        if tls.get('status') == 'observed' and type(seconds) in (int, float):
            signals['tls'] = 'bad' if seconds < policy['tls_min_seconds'] else 'ok'
    if fresh(host):
        signals['database'] = status(host.get('services', {}).get('db', {}).get('status'))
        disks = [host.get('disks', {}).get(name, {}) for name in policy['disks']]
        states = [status(item.get('status')) for item in disks]
        states += [status(item.get('inodes', {}).get('status')) for item in disks]
        signals['disk'] = 'bad' if 'bad' in states else 'unknown' if 'unknown' in states else 'ok'
    # A failed HTTPS observation already covers inaccessible TLS; don't add a duplicate no-data event.
    if signals['external_readiness'] == 'bad' and signals['tls'] == 'unknown':
        signals['tls'] = 'suppressed'
    return signals


def run_cycle(policy, host, external, previous=None, now=None, deliver=None):
    validate(policy)
    if not policy['enabled']:
        return {}, {'status': 'not_configured', 'events': []}
    now = time.time() if now is None else now
    previous = previous or {}
    state, events = {}, []
    for signal, sample in observations(host, external, policy, now).items():
        old = previous.get(signal, {})
        if not isinstance(old, dict):
            raise ValueError('invalid_state')
        prior = old.get('sample')
        if type(old.get('count', 0)) is not int or not 0 <= old.get('count', 0) <= 60:
            raise ValueError('invalid_state')
        count = min(old.get('count', 0) + 1, 60) if sample == prior else 1
        notified = old.get('notified')
        serial = old.get('serial', 0)
        if notified not in (None, 'ok', 'bad', 'unknown') or type(serial) is not int or not 0 <= serial < 1000000000:
            raise ValueError('invalid_state')
        item = {'sample': sample, 'count': count, 'notified': notified, 'serial': serial}
        desired = sample if count >= policy['debounce_samples'] and sample != 'suppressed' else None
        if desired == 'ok' and notified is None:
            item['notified'] = 'ok'  # No recovered event when a failure was never delivered.
        elif desired is not None and desired != notified:
            if desired != old.get('desired'):
                serial += 1
            item.update(serial=serial, desired=desired)
            event = {'id': f'{signal}:{serial}', 'signal': signal,
                     'state': 'resolved' if desired == 'ok' else 'firing' if desired == 'bad' else 'no_data'}
            accepted = False
            if deliver is not None:
                try:
                    accepted = deliver(dict(event)) is True
                except Exception:
                    pass
            if accepted:
                item['notified'] = desired
            events.append(dict(event, delivery='accepted' if accepted else 'pending'))
        state[signal] = item
    return state, {'status': 'observed', 'events': events}


def read_json(path):
    path = Path(path)
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('unsafe_input')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('unsafe_input')
        raw = stream.read(128 * 1024 + 1)
    if len(raw) > 128 * 1024:
        raise ValueError('oversized_input')
    return json.loads(raw)


def write_state(path, state):
    if path.is_symlink() or not path.parent.is_dir():
        raise ValueError('unsafe_state')
    fd, name = tempfile.mkstemp(prefix='.alert-state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--host')
    parser.add_argument('--external')
    parser.add_argument('--state', type=Path)
    args = parser.parse_args(argv)
    lock = None
    try:
        config = validate(read_json(args.config))
        if not config['enabled']:
            print(json.dumps({'status': 'not_configured', 'events': []})); return 2
        if args.state is None:
            raise ValueError('state_required')
        # One caller owns state; never clear another process's lock automatically.
        lock_path = args.state.with_name(args.state.name + '.lock')
        lock = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        previous = read_json(args.state) if args.state.exists() else {}
        host = read_json(args.host) if args.host else {}
        external = read_json(args.external) if args.external else {}
        state, result = run_cycle(config, host, external, previous)
        write_state(args.state, state)
        print(json.dumps(result, sort_keys=True))
        return 1 if result['events'] else 0
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        print(json.dumps({'status': 'unknown', 'events': []})); return 2
    finally:
        if lock is not None:
            os.close(lock); lock_path.unlink()


if __name__ == '__main__':
    raise SystemExit(main())
