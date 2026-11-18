"""Bounded logging examples and opt-in rotation checks on an isolated stack."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILES = ['compose.yaml', 'backend/docker-compose.yml',
                 'frontend/docker-compose.yml', 'deploy/production/compose.yml']


def compose_model(relative):
    # Copy examples so neither Compose include nor env discovery reads local secrets.
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for name in COMPOSE_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        environment = dict(os.environ, DATABASE_NAME='logging_test', DATABASE_USER='tester',
                           DATABASE_PASSWORD='fixture-only', ADMIN_PASSWORD='fixture-only',
                           JWT_SECRET_KEY='fixture-signing-key-not-a-real-secret',
                           JWT_REFRESH_KEY='fixture-only', DATABASE_URL='postgres://tester:fixture@db/logging_test',
                           BACKEND_IMAGE='example/backend:v1.6.0', FRONTEND_IMAGE='example/frontend:v2.2.0',
                           BACKEND_CONFIG='/fixture/backend.yaml', CADDY_CONFIG='/fixture/Caddyfile',
                           LOKI_CONFIG='/fixture/loki.yaml', CUSTOM_ASSETS='/fixture/assets',
                           COMPOSE_PROJECT_NAME='clockwork-logging-config-test')
        result = subprocess.run(['docker', 'compose', '--env-file', os.devnull, '--profile', '*',
                                 '-f', str(root / relative), 'config', '--format', 'json'],
                                env=environment, capture_output=True, check=True, timeout=30)
        return json.loads(result.stdout)


@unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI required for example checks')
class ComposeLoggingTest(unittest.TestCase):
    def test_every_example_service_has_bounded_local_logs(self):
        for name in COMPOSE_FILES:
            with self.subTest(example=name):
                model = compose_model(name)
                self.assertTrue(model['services'])
                for service in model['services'].values():
                    self.assertEqual(service['logging'], {
                        'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}})

    def test_production_audit_volumes_network_and_services_are_unchanged(self):
        model = compose_model('deploy/production/compose.yml')
        self.assertEqual(set(model['services']), {'db', 'erp', 'frontend', 'caddy', 'loki'})
        self.assertEqual(model['volumes']['loki_data']['name'], 'erp_loki_data')
        self.assertTrue(model['volumes']['loki_data']['external'])
        self.assertEqual(model['volumes']['db_data']['name'], 'erp-infra_db_data')
        self.assertEqual(model['networks']['app-network']['name'], 'erp_app-network')
        self.assertEqual(model['services']['caddy']['networks']['app-network']['ipv4_address'], '172.18.0.5')
        self.assertNotIn('ports', model['services']['loki'])


@unittest.skipUnless(os.environ.get('CLOCKWORK_LOGGING_DOCKER_TESTS') == '1',
                     'enable isolated Docker log rotation explicitly')
class DockerLoggingTest(unittest.TestCase):
    def test_repeated_rotation_bounds_history_preserves_stderr_and_survives_restart(self):
        policy = compose_model('deploy/production/compose.yml')['services']['erp']['logging']
        project = 'clockwork-logging-test-' + uuid.uuid4().hex
        script = '''set -eu
if [ -f /tmp/complete ]; then
  echo RESTART_OK
  exec sleep 300
fi
printf 'keep-data' > /tmp/data.marker
payload=$(printf '%8192s' x)
for wave in 1 2; do
  echo BEGIN_$wave
  i=0
  while [ "$i" -lt 6400 ]; do
    printf 'ROW_%s_%05d %s\\n' "$wave" "$i" "$payload"
    i=$((i + 1))
  done
  echo END_$wave
  echo STDERR_END_$wave >&2
  touch /tmp/wave$wave
  if [ "$wave" = 1 ]; then
    while [ ! -f /tmp/continue ]; do sleep 1; done
  fi
done
touch /tmp/complete
exec sleep 300
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'compose.json'
            path.write_text(json.dumps({'services': {'emitter': {
                'image': 'node:22-alpine', 'entrypoint': ['sh', '-c', script.replace('$', '$$')], 'logging': policy,
                'network_mode': 'none'}}}))
            cli = ['docker', 'compose', '--project-name', project, '--env-file', os.devnull, '-f', str(path)]
            def run(*args):
                return subprocess.run([*cli, *args], check=True, capture_output=True, timeout=120).stdout
            def wait_file(name):
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    probe = subprocess.run([*cli, 'exec', '-T', 'emitter', 'test', '-f', name],
                                           capture_output=True, timeout=10)
                    if probe.returncode == 0:
                        return
                    time.sleep(0.1)
                self.fail('Timed out waiting for isolated emitter: ' + name)
            def history(container):
                size = 0
                markers = set()
                with subprocess.Popen(['docker', 'logs', container], stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT) as process:
                    for line in process.stdout:
                        size += len(line)
                        if line.startswith((b'BEGIN_', b'END_', b'STDERR_END_', b'RESTART_')):
                            markers.add(line.strip().decode())
                    self.assertEqual(process.wait(timeout=30), 0)
                return size, markers
            try:
                # No image build/pull, host bind, port or data volume is needed.
                run('up', '-d', '--no-build', '--pull', 'never')
                container = run('ps', '-q', 'emitter').decode().strip()
                actual = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
                self.assertEqual(actual['HostConfig']['LogConfig'], {'Type': 'json-file', 'Config': policy['options']})
                self.assertEqual(actual['Mounts'], [])
                for wave in [1, 2]:
                    wait_file('/tmp/wave' + str(wave))
                    size, markers = history(container)
                    self.assertGreater(size, 10 * 1024 * 1024)
                    self.assertLess(size, 30 * 1024 * 1024 + 65536)
                    self.assertNotIn('BEGIN_' + str(wave), markers)
                    self.assertIn('END_' + str(wave), markers)
                    self.assertIn('STDERR_END_' + str(wave), markers)
                    if wave == 1:
                        run('exec', '-T', 'emitter', 'touch', '/tmp/continue')
                run('restart', 'emitter')
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    size, markers = history(container)
                    if 'RESTART_OK' in markers:
                        break
                    time.sleep(0.1)
                self.assertIn('RESTART_OK', markers)
                self.assertLess(size, 30 * 1024 * 1024 + 65536)
                self.assertEqual(run('exec', '-T', 'emitter', 'cat', '/tmp/data.marker'), b'keep-data')
            finally:
                run('down', '--volumes')
