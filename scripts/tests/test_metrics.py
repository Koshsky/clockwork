"""Opt-in runtime checks that example gateways never expose private metrics."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get('CLOCKWORK_METRICS_DOCKER_TESTS') == '1',
                     'opt-in isolated Caddy runtime check')
class MetricsGatewayTest(unittest.TestCase):
    def test_public_gateways_deny_metrics_without_an_upstream(self):
        self.assertIsNotNone(shutil.which('docker'))
        subprocess.run(['docker', 'image', 'inspect', 'caddy:2-alpine'],
                       check=True, capture_output=True, timeout=30)
        for example in ['deploy/Caddyfile', 'deploy/production/Caddyfile']:
            with self.subTest(example=example):
                config = (ROOT / example).read_text()
                # Exercise the repository handlers without certificates, a public
                # listener, upstream services, published ports or application data.
                config = config.replace('erp.koshsky.ru {', ':80 {', 1)
                name = 'clockwork-metrics-test-' + uuid.uuid4().hex
                def docker(*args, check=True):
                    result = subprocess.run(['docker', *args], capture_output=True,
                                            text=True, timeout=30)
                    if check and result.returncode:
                        raise RuntimeError('Docker fixture failed: ' + result.stderr)
                    return result
                try:
                    docker('run', '-d', '--pull', 'never', '--name', name,
                           '--network', 'none', '--read-only', '--tmpfs', '/data',
                           '--tmpfs', '/config', '-e', 'CLOCKWORK_CADDY_FIXTURE=' + config,
                           '--entrypoint', 'sh', 'caddy:2-alpine', '-c',
                           "printf '%s' \"$CLOCKWORK_CADDY_FIXTURE\" > /config/Caddyfile; "
                           'exec caddy run --config /config/Caddyfile --adapter caddyfile')
                    for _ in range(50):
                        result = docker('exec', name, 'wget', '-S', '-O', '-',
                                        'http://127.0.0.1/metrics', check=False)
                        if '404 Not Found' in result.stderr:
                            break
                        time.sleep(0.1)
                    else:
                        self.fail('private metrics guard was not ready: ' + result.stderr)
                    for endpoint in ['/metrics', '/metrics/private', '/metrics?query=fixture', '/%6detrics']:
                        result = docker('exec', name, 'wget', '-S', '-O', '-',
                                        'http://127.0.0.1' + endpoint, check=False)
                        self.assertIn('404 Not Found', result.stderr)
                        self.assertNotIn('go_goroutines', result.stdout)
                        self.assertNotIn('clockwork_http_', result.stdout)
                    inspect = json.loads(docker('inspect', name).stdout)[0]
                    self.assertEqual(inspect['HostConfig']['NetworkMode'], 'none')
                    self.assertFalse(inspect['HostConfig']['PortBindings'])
                    self.assertFalse(any(m['Type'] in ['bind', 'volume'] for m in inspect['Mounts']))
                finally:
                    docker('rm', '-f', '-v', name, check=False)
