#!/usr/bin/env python3
"""Explicit external readiness/TLS observation; never logs in or follows redirects."""
import argparse
import http.client
import ipaddress
import json
import os
import stat
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit


def validate_url(value):
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError('invalid_url')
    url = urlsplit(value)
    if (not url.hostname or url.username or url.password or url.query or url.fragment
            or url.path not in ('', '/') or url.scheme not in ('http', 'https')):
        raise ValueError('invalid_url')
    if url.scheme == 'http':
        try:
            local = ipaddress.ip_address(url.hostname).is_loopback
        except ValueError:
            local = url.hostname == 'localhost'
        if not local:
            raise ValueError('https_required')
    if any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError('invalid_url')
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError('invalid_url')
    return url


def probe(value):
    url = validate_url(value)
    connection = None
    try:
        secure = url.scheme == 'https'
        connection = (http.client.HTTPSConnection(url.hostname, url.port, timeout=4, context=ssl.create_default_context())
                      if secure else http.client.HTTPConnection(url.hostname, url.port, timeout=4))
        connection.connect()
        remaining = int(ssl.cert_time_to_seconds(connection.sock.getpeercert()['notAfter']) - time.time()) if secure else None
        connection.request('GET', '/api/v1/ready', headers={'Accept': 'application/json', 'Connection': 'close'})
        response = connection.getresponse()
        raw = response.read(4097)
        ready = False
        if len(raw) <= 4096 and response.status == 200:
            try:
                body = json.loads(raw)
                ready = body.get('data', {}).get('status') == 'ready' and not body.get('error')
            except (ValueError, TypeError, AttributeError):
                pass
        return {'status': 'ok' if ready else 'failed', 'reachable': True, 'http_status': response.status,
                'tls': {'status': 'observed', 'remaining_seconds': remaining} if secure else {'status': 'not_configured'}}
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return {'status': 'failed', 'reachable': False, 'tls': {'status': 'unknown'}}
    finally:
        if connection:
            connection.close()


def bounded_probe(value):
    # An entire child is bounded, including blocking DNS resolution in the OS.
    validate_url(value)
    try:
        result = subprocess.run([sys.executable, __file__, '--worker-url', value],
                                capture_output=True, timeout=6, check=True)
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return {'status': 'unknown', 'reachable': False, 'tls': {'status': 'unknown'}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--worker-url', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if args.worker_url:
            report = probe(args.worker_url)
        else:
            from pathlib import Path
            path = Path(args.config)
            if any(p.is_symlink() for p in (path, *path.parents)):
                raise ValueError('invalid_config')
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('invalid_config')
                raw = stream.read(4097)
            if len(raw) > 4096:
                raise ValueError('invalid_config')
            config = json.loads(raw)
            if not isinstance(config, dict) or set(config) != {'enabled', 'url'} or type(config['enabled']) is not bool:
                raise ValueError('invalid_config')
            report = bounded_probe(config['url']) if config['enabled'] else {'status': 'not_configured'}
    except (OSError, ValueError, TypeError):
        report = {'status': 'unknown'}
    if report['status'] != 'not_configured':
        report.setdefault('checked_at', time.time())
    print(json.dumps(report, sort_keys=True))
    # A worker reports failures as data, not subprocess errors.
    return 0 if args.worker_url or report['status'] == 'ok' else 1 if report['status'] == 'failed' else 2


if __name__ == '__main__':
    sys.exit(main())
