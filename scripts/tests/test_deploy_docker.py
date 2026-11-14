"""Opt-in destructive checks, confined to freshly created test containers/volumes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location('deploy_docker', Path(__file__).resolve().parents[1] / 'deploy.py')
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


@unittest.skipUnless(os.environ.get('CLOCKWORK_DEPLOY_DOCKER_TESTS') == '1', 'enable isolated Docker smoke tests explicitly')
class DockerReconcileTest(unittest.TestCase):
    def test_reconcile_preserves_data_secrets_and_container_identity_then_restores_dump(self):
        name = 'clockwork-deploy-test-' + uuid.uuid4().hex
        password = 'a$${NOT_A_VARIABLE}"\'\nspaces é :/?%'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / 'compose.yml'
            template = '''services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: tester
      POSTGRES_DB: testdb
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
    volumes: [data:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U tester -d testdb']
      interval: 1s
      timeout: 5s
      retries: 30
volumes:
  data:
'''
            path.write_bytes(deploy.render(template, {'DATABASE_PASSWORD': password}))
            cli = ['docker', 'compose', '--project-name', name, '--env-file', '/dev/null', '-f', str(path)]
            def run(*args, stdin=None, stdout=subprocess.PIPE):
                return subprocess.run([*cli, *args], input=stdin, stdout=stdout,
                                      stderr=subprocess.PIPE, check=True, timeout=180).stdout
            def sql(query):
                return run('exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'tester',
                           '-d', 'testdb', '-Atc', query).decode().strip()
            try:
                run('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
                first_id = run('ps', '-q', 'db').decode().strip()
                inspected = json.loads(subprocess.check_output(['docker', 'inspect', first_id]))[0]
                actual_env = dict(e.split('=', 1) for e in inspected['Config']['Env'] if '=' in e)
                self.assertEqual(actual_env['POSTGRES_PASSWORD'], password)
                sql('CREATE TABLE schema_migrations(version bigint, dirty boolean);')
                for rows, expected in [('', '0'), ('(14,false)', '1'), ('(13,false),(14,false)', '0'),
                                       ('(13,false),(14,true)', '0'), ('(14,true)', '0')]:
                    sql('TRUNCATE schema_migrations')
                    if rows:
                        sql('INSERT INTO schema_migrations VALUES ' + rows)
                    self.assertEqual(sql(deploy.MIGRATION_CHECK), expected)
                sql('TRUNCATE schema_migrations; INSERT INTO schema_migrations VALUES (14,false)')
                sql('CREATE TABLE deploy_marker (id integer PRIMARY KEY, value text); '
                    "INSERT INTO deploy_marker VALUES (1, 'keep-data');")
                run('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
                self.assertEqual(run('ps', '-q', 'db').decode().strip(), first_id)
                self.assertEqual(sql('SELECT value FROM deploy_marker'), 'keep-data')
                # A Compose configuration change recreates the container, keeping its data volume.
                path.write_text(path.read_text().replace('POSTGRES_DB: testdb', 'POSTGRES_DB: testdb\n      TEST_CONFIG: changed'))
                run('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
                self.assertNotEqual(run('ps', '-q', 'db').decode().strip(), first_id)
                self.assertEqual(sql('SELECT value FROM deploy_marker'), 'keep-data')
                with (root / 'database.dump').open('wb') as stream:
                    run('exec', '-T', 'db', 'pg_dump', '-U', 'tester', '-d', 'testdb', '-Fc', stdout=stream)
                sql('DROP TABLE deploy_marker; DROP TABLE schema_migrations')
                run('exec', '-T', 'db', 'pg_restore', '-U', 'tester', '-d', 'testdb', '--exit-on-error',
                    stdin=(root / 'database.dump').read_bytes())
                self.assertEqual(sql('SELECT value FROM deploy_marker'), 'keep-data')
            finally:
                # The random project owns these resources; production identifiers are never used.
                run('down')
                subprocess.run(['docker', 'volume', 'rm', name + '_data'], check=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)


@unittest.skipUnless(os.environ.get('CLOCKWORK_DEPLOY_DOCKER_TESTS') == '1', 'enable isolated Docker smoke tests explicitly')
class DockerLokiReadinessTest(unittest.TestCase):
    def test_real_production_loki_config_reaches_ready_through_the_caddy_probe(self):
        from unittest.mock import patch
        name = 'clockwork-loki-test-' + uuid.uuid4().hex
        config = Path(__file__).resolve().parents[2] / 'deploy/production/loki.yaml'
        def docker(*args):
            return subprocess.run(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  check=True, timeout=180).stdout
        docker('network', 'create', name)
        try:
            docker('run', '-d', '--name', name, '--network', name, '--network-alias', 'loki', '--user', '0',
                   '--mount', 'type=bind,source=' + str(config) + ',target=/etc/loki/loki.yaml,readonly',
                   'grafana/loki:3.4.2', '-config.file=/etc/loki/loki.yaml',
                   '-querier.split-queries-by-interval=24h')
            original = deploy.command
            def probe(args, **kwargs):
                self.assertIn('erp_app-network', args)
                return original([name if arg == 'erp_app-network' else arg for arg in args], **kwargs)
            with patch.object(deploy, 'command', side_effect=probe):
                deploy.wait_loki('caddy:2-alpine')
        finally:
            subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           check=False, timeout=30)
            docker('network', 'rm', name)


@unittest.skipUnless(os.environ.get('CLOCKWORK_DEPLOY_DOCKER_TESTS') == '1', 'enable isolated Docker smoke tests explicitly')
class DockerProxyOrderTest(unittest.TestCase):
    def test_proxy_keeps_reserved_ip_during_full_recreation_and_repeat_keeps_data_and_ids(self):
        import ipaddress
        name = 'clockwork-proxy-test-' + uuid.uuid4().hex
        def docker(*args):
            return subprocess.run(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  check=True, timeout=180).stdout
        docker('pull', 'caddy:2-alpine')
        docker('network', 'create', name)
        try:
            docker('volume', 'create', name)
            network = json.loads(docker('network', 'inspect', name))[0]
            gateway = ipaddress.ip_address(network['IPAM']['Config'][0]['Gateway'])
            proxy_ip = str(gateway + 1)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp).resolve() / 'compose.yml'
                def configure(generation, legacy):
                    model = {'services': {}, 'networks': {'app': {'external': True, 'name': name}},
                             'volumes': {'data': {'external': True, 'name': name}}}
                    for offset, service in enumerate(('caddy', 'db', 'loki', 'erp', 'frontend'), start=1):
                        attachment = {'ipv4_address': str(gateway + offset)} if legacy or service == 'caddy' else {}
                        model['services'][service] = {
                            'image': 'caddy:2-alpine', 'entrypoint': ['/bin/sh'],
                            'command': ['-c', 'exec sleep 300'], 'environment': {'GENERATION': generation},
                            'networks': {'app': attachment},
                        }
                    model['services']['caddy']['depends_on'] = ['frontend', 'erp']
                    model['services']['db']['volumes'] = ['data:/data']
                    path.write_text(json.dumps(model))
                def run(*args):
                    return docker('compose', '--project-name', name, '--env-file', '/dev/null', '-f', str(path), *args)
                def inspect():
                    ids = run('ps', '-aq').decode().split()
                    return {c['Config']['Labels']['com.docker.compose.service']: c
                            for c in json.loads(docker('inspect', *ids))}
                up = ('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '30')
                configure('old', legacy=True)
                try:
                    run(*up)
                    run('exec', '-T', 'db', 'sh', '-c', 'printf keep-data > /data/marker')
                    before = inspect()
                    run('stop', '--timeout', '1', 'caddy', 'erp')
                    configure('new', legacy=False)
                    run(*up, '--no-deps', 'caddy')
                    reserved = inspect()
                    self.assertEqual(reserved['caddy']['NetworkSettings']['Networks'][name]['IPAddress'], proxy_ip)
                    self.assertNotEqual(reserved['caddy']['Id'], before['caddy']['Id'])
                    for service in ('db', 'loki', 'erp', 'frontend'):
                        self.assertEqual(reserved[service]['Id'], before[service]['Id'])
                    self.assertFalse(reserved['erp']['State']['Running'])
                    run(*up, 'db', 'loki')
                    self.assertFalse(inspect()['erp']['State']['Running'])
                    run(*up)
                    after = inspect()
                    self.assertEqual(after['caddy']['Id'], reserved['caddy']['Id'])
                    self.assertEqual(after['caddy']['NetworkSettings']['Networks'][name]['IPAddress'], proxy_ip)
                    for service, container in after.items():
                        self.assertTrue(container['State']['Running'])
                        self.assertNotEqual(container['Id'], before[service]['Id'])
                        if service != 'caddy':
                            self.assertNotEqual(container['NetworkSettings']['Networks'][name]['IPAddress'], proxy_ip)
                    self.assertEqual(run('exec', '-T', 'db', 'cat', '/data/marker'), b'keep-data')
                    run(*up, '--no-deps', 'caddy')
                    run(*up, 'db', 'loki')
                    run(*up)
                    self.assertEqual({s: c['Id'] for s, c in inspect().items()}, {s: c['Id'] for s, c in after.items()})
                    self.assertEqual(run('exec', '-T', 'db', 'cat', '/data/marker'), b'keep-data')
                finally:
                    run('down', '--volumes', '--timeout', '1')
        finally:
            subprocess.run(['docker', 'volume', 'rm', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           check=False, timeout=30)
            docker('network', 'rm', name)
