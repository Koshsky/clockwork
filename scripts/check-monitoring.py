#!/usr/bin/env python3
"""Validate the separate opt-in monitoring model without starting containers."""
import ipaddress
import json
import os
from pathlib import Path
import stat
import subprocess


def private(value):
    ip = ipaddress.ip_address(value)
    return ip.is_loopback or any(ip in net for net in map(ipaddress.ip_network,
        ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7')) if net.version == ip.version)


def validate(model):
    services = model['services']
    if set(services) != {'prometheus', 'grafana'}:
        raise ValueError('unexpected_services')
    memory = [int(service['mem_limit']) for service in services.values()]
    if any(value <= 0 for value in memory) or sum(memory) > 1024 ** 3:
        raise ValueError('memory_budget')
    for service in services.values():
        if (service.get('ports') or service.get('privileged') or service.get('pid') == 'host'
                or not service.get('read_only') or service.get('cap_drop') != ['ALL']
                or not service.get('network_mode', '').startswith('container:')
                or 'monitoring' not in service.get('profiles', []) or '@sha256:' not in service['image']):
            raise ValueError('unsafe_service')
        for mount in service.get('volumes', []):
            if 'docker.sock' in str(mount) or mount['target'] in ('/', '/var/run'):
                raise ValueError('unsafe_mount')
    if services['grafana']['network_mode'] != services['prometheus']['network_mode']:
        raise ValueError('namespace_mismatch')
    env = services['grafana']['environment']
    if (not private(env['GF_SERVER_HTTP_ADDR']) or env['GF_AUTH_ANONYMOUS_ENABLED'] != 'false'
            or env['GF_ANALYTICS_REPORTING_ENABLED'] != 'false'):
        raise ValueError('unsafe_grafana')
    password = Path(model['secrets']['admin_password']['file'])
    if (not password.is_absolute() or password.is_symlink() or not stat.S_ISREG(password.stat().st_mode)
            or password.stat().st_size < 16 or password.parent.stat().st_mode & 0o077):
        raise ValueError('private_external_password_required')
    return {'status': 'validated', 'services': 2, 'memory_limit_bytes': sum(memory),
            'published_ports': 0}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compose', type=Path, default=Path(__file__).resolve().parents[1] / 'deploy/observability/compose.yml')
    args = parser.parse_args()
    try:
        result = subprocess.run(['docker', 'compose', '-f', str(args.compose), '--profile', 'monitoring', 'config', '--format', 'json'],
                                capture_output=True, check=True, timeout=15)
        print(json.dumps(validate(json.loads(result.stdout)), sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        print(json.dumps({'status': 'invalid_configuration'})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
