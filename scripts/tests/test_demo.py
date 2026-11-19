"""Read-only demo observations, failure semantics and privacy boundaries."""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

SPEC = importlib.util.spec_from_file_location('demo', Path(__file__).resolve().parents[1] / 'check-demo.py')
demo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(demo)


class DemoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.config = {'enabled': True, 'root': str(self.root), 'project': 'erp'}
        self.now = time.time()
        (self.root / '.clockwork/backups').mkdir(parents=True)
        (self.root / '.clockwork/requests').mkdir()

    def backup(self, suffix='1', complete=True):
        path = self.root / '.clockwork/backups' / ('a' * 64 + '-' + suffix)
        path.mkdir()
        (path / 'database.dump').write_bytes(b'isolated fixture dump')
        os.utime(path / 'database.dump', (self.now - 100, self.now - 100))
        if complete:
            (path / 'complete').write_bytes(b'verified dump archive\n')
        return path

    def receipt(self, path, age=50):
        item = {'schema': 1, 'result': 'restored_and_checked',
                'dump_sha256': hashlib.sha256((path / 'database.dump').read_bytes()).hexdigest(),
                'restored_at': dt.datetime.fromtimestamp(self.now - age, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
        (path / 'restore-test.json').write_text(json.dumps(item))
        return item

    def test_example_is_disabled_without_running_any_observer(self):
        example = Path(__file__).resolve().parents[2] / 'deploy/observability/demo-check.example.json'
        with patch.object(demo, 'collect') as collect, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(demo.main(['--config', str(example)]), 2)
        collect.assert_not_called()
        self.assertEqual(json.loads(out.getvalue()), {'status': 'not_configured'})

    def test_invalid_configuration_does_not_leak_its_values(self):
        path = self.root / 'config.json'
        path.write_text('{secret-password')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(demo.main(['--config', str(path)]), 2)
        self.assertNotIn('secret-password', out.getvalue())
        self.assertNotIn(str(self.root), out.getvalue())

    def test_configuration_rejects_untrusted_commands_paths_and_policies(self):
        variants = [{'project': 'x;secret'}, {'root': 'relative'}, {'enabled': 'yes'},
                    {'containers': {'db': '--format=secret'}}, {'containers': {'secret-user': 'db'}},
                    {'disks': {'secret-user': '/'}}, {'disks': {'audit': 1}},
                    {'limits': {'min_available_disk_bytes': -1}}, {'limits': {'min_available_inodes': True}},
                    {'limits': {'max_backup_age_seconds': float('nan')}}, {'password': 'secret'},
                    {'tls': {'host': 'https://secret:password@host', 'port': 443}},
                    {'tls': {'host': 'host', 'port': True}}, {'tls': {'host': 'host', 'port': 0}}]
        for changes in variants:
            with self.subTest(changes=changes), self.assertRaises(demo.ObservationError):
                demo.validate(dict(self.config, **changes))

    def test_memory_uses_available_not_free_bytes_and_threshold_boundary(self):
        path = self.root / 'meminfo'
        path.write_text('MemTotal: 2000 kB\nMemFree: 1 kB\nMemAvailable: 1000 kB\n')
        for limit, status in [(1024000, 'ok'), (1024001, 'failed'), (None, 'observed')]:
            with self.subTest(limit=limit):
                item = demo.memory({'min_available_memory_bytes': limit}, path)
                self.assertEqual((item['status'], item['available_bytes']), (status, 1024000))

    def test_missing_available_memory_is_unknown(self):
        path = self.root / 'meminfo'
        path.write_text('MemTotal: 2000 kB\nMemFree: 1000 kB\n')
        self.assertEqual(demo.observe(demo.memory, {}, path), {'status': 'unknown'})

    def test_low_disk_and_inode_exhaustion_are_independent(self):
        info = SimpleNamespace(f_bavail=10, f_bfree=900, f_frsize=1024, f_blocks=1000, f_files=100, f_favail=2)
        with patch.object(demo.os, 'statvfs', return_value=info):
            low_disk = demo.disk('/', {'min_available_disk_bytes': 10241, 'min_available_inodes': 2})
            low_inode = demo.disk('/', {'min_available_disk_bytes': 10240, 'min_available_inodes': 3})
            no_policy = demo.disk('/', {})
        self.assertEqual((low_disk['status'], low_disk['inodes']['status']), ('failed', 'ok'))
        self.assertEqual((low_inode['status'], low_inode['inodes']['status']), ('ok', 'failed'))
        self.assertEqual(no_policy['status'], 'observed')
        info.f_files = 0
        with patch.object(demo.os, 'statvfs', return_value=info):
            self.assertEqual(demo.disk('/', {})['inodes']['status'], 'unknown')

    def test_local_files_are_bounded_regular_and_not_symlinks(self):
        path = self.root / 'input'
        path.write_bytes(b'x' * (demo.LIMIT + 1))
        self.assertEqual(demo.observe(demo.read_file, path), {'status': 'unknown'})
        link = self.root / 'link'
        link.symlink_to(path)
        self.assertEqual(demo.observe(demo.read_file, link), {'status': 'unknown'})
        fifo = self.root / 'fifo'
        os.mkfifo(fifo)
        self.assertEqual(demo.observe(demo.read_file, fifo), {'status': 'unknown'})

    def item(self, **changes):
        return dict({'project': 'erp', 'service': 'db', 'running': True,
                     'image': 'sha256:' + 'b' * 64, 'container_id': 'c' * 64, 'restarts': 2, 'health': 'healthy'}, **changes)

    def test_db_health_distinguishes_ready_starting_stopped_and_missing_health(self):
        for changes, status in [({}, 'ok'), ({'health': 'starting'}, 'failed'),
                                ({'health': 'unhealthy'}, 'failed'), ({'running': False}, 'failed'),
                                ({'health': None}, 'unknown')]:
            with self.subTest(changes=changes), patch.object(demo, 'docker_json', return_value=self.item(**changes)):
                self.assertEqual(demo.container('db', 'db', 'erp')['status'], status)

    def test_wrong_project_or_service_never_reports_another_stack(self):
        for changes in [{'project': 'other'}, {'service': 'erp'}, {'image': 'password'}, {'restarts': -1}]:
            with self.subTest(changes=changes), patch.object(demo, 'docker_json', return_value=self.item(**changes)):
                self.assertEqual(demo.observe(demo.container, 'db', 'db', 'erp'), {'status': 'unknown'})

    def test_docker_failure_is_sanitized_and_does_not_hide_other_observations(self):
        error = subprocess.CalledProcessError(1, 'secret', stderr=b'PASSWORD=secret')
        self.config['containers'] = {'db': 'db'}
        with patch.object(demo, 'docker_json', side_effect=error):
            result = demo.collect(self.config)
        self.assertEqual(result['services']['db'], {'status': 'unknown'})
        self.assertIn('backup', result)
        self.assertNotIn('secret', json.dumps(result))

    def test_image_tags_only_report_canonical_versions_of_the_right_repository(self):
        tags = ['koshsky/erp-frontend:v2.2.0', 'koshsky/erp-frontend:latest',
                'private/password:v1.0.0', 'koshsky/erp-frontend:v02.0.0', 'koshsky/erp-backend:v1.6.0']
        with patch.object(demo, 'docker_json', return_value=tags):
            self.assertEqual(demo.image_tags('sha256:' + 'a' * 64, 'frontend'),
                             {'status': 'ok', 'local_version_tags': ['v2.2.0']})
        with patch.object(demo, 'docker_json', return_value=None):
            self.assertEqual(demo.image_tags('sha256:' + 'a' * 64, 'erp')['status'], 'unknown')

    def test_versions_come_from_running_service_metadata_not_moving_tags(self):
        for service, data, expected in [('erp', {'data': {'version': 'v1.6.0', 'changelog_ru': 'private'}}, '1.6.0'),
                                        ('frontend', {'protocol': 1, 'target': 'web', 'version': '2.2.0', 'modules': ['private']}, '2.2.0')]:
            with self.subTest(service=service), patch.object(demo, 'docker_json', return_value=data) as run:
                result = demo.runtime_version('c' * 64, service)
                self.assertEqual(result, {'status': 'ok', 'version': expected})
                self.assertEqual(run.call_args.args[:2], ('exec', 'c' * 64))
                self.assertNotIn('private', json.dumps(result))

    def test_bad_or_missing_release_metadata_never_falls_back_to_alias(self):
        for data in [{'protocol': 1, 'target': 'desktop', 'version': '2.2.0'},
                     {'protocol': 1, 'target': 'web', 'version': 'secret-password'}, {}]:
            with self.subTest(data=data), patch.object(demo, 'docker_json', return_value=data):
                self.assertEqual(demo.observe(demo.runtime_version, 'c' * 64, 'frontend'), {'status': 'unknown'})

    def test_container_query_never_requests_environment_health_logs_or_mounts(self):
        with patch.object(demo, 'docker_json', return_value=self.item()) as query:
            demo.container('db', 'db', 'erp')
        args = query.call_args.args
        self.assertEqual(args[:3], ('container', 'inspect', '--format'))
        for forbidden in ('.Config.Env', '.Log', '.Mounts'):
            self.assertNotIn(forbidden, args[3])

    def test_docker_invocation_has_timeout_no_shell_and_discards_stderr(self):
        def run(args, **kwargs):
            self.assertEqual(args, ['docker', 'image', 'inspect'])
            self.assertNotIn('shell', kwargs)
            self.assertEqual(kwargs['timeout'], 5)
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            kwargs['stdout'].write(b'null')
        with patch.object(demo.subprocess, 'run', side_effect=run):
            self.assertIsNone(demo.docker_json('image', 'inspect'))

    def test_tls_missing_target_never_opens_a_socket(self):
        with patch.object(socket, 'create_connection') as connect:
            self.assertEqual(demo.tls_expiry(None, {}, self.now), {'status': 'not_configured'})
        connect.assert_not_called()

    def test_tls_verifies_peer_and_reports_expiry_without_certificate_contents(self):
        secure = Mock()
        expiry = time.strftime('%b %d %H:%M:%S %Y GMT', time.gmtime(self.now + 3600))
        secure.__enter__ = Mock(return_value=secure)
        secure.__exit__ = Mock(return_value=False)
        secure.getpeercert.return_value = {'notAfter': expiry, 'subject': 'secret'}
        context = Mock()
        context.wrap_socket.return_value = secure
        with patch.object(socket, 'create_connection') as connect, patch.object(ssl, 'create_default_context', return_value=context):
            connect.return_value.__enter__.return_value = Mock()
            result = demo.tls_expiry({'host': 'fixture.test', 'port': 443}, {'min_tls_remaining_seconds': 7200}, self.now)
        self.assertEqual(result['status'], 'failed')
        context.wrap_socket.assert_called_once()
        self.assertEqual(context.wrap_socket.call_args.kwargs, {'server_hostname': 'fixture.test'})
        self.assertNotIn('secret', json.dumps(result))

    def test_tls_validation_errors_and_connection_failures_are_unknown(self):
        for error in [ssl.SSLCertVerificationError('secret'), TimeoutError('private host'), OSError('secret')]:
            with self.subTest(error=type(error)), patch.object(socket, 'create_connection', side_effect=error):
                result = demo.observe(demo.tls_expiry, {'host': 'fixture.test', 'port': 443}, {}, self.now)
                self.assertEqual(result, {'status': 'unknown'})

    def deploy(self, phase, age=10, request='c' * 64):
        path = self.root / '.clockwork/requests' / request
        path.mkdir()
        status = path / 'status.json'
        status.write_text(json.dumps({'request': request, 'phase': phase, 'error': 'secret password',
                                      'environment': 'secret', 'backup': '/private/secret'}))
        os.utime(status, (self.now - age, self.now - age))
        return path

    def test_deploy_failure_success_and_stall_are_distinct_and_private(self):
        path = self.deploy('failed')
        for phase, expected in [('failed', 'failed'), ('succeeded', 'ok'), ('backup', 'in_progress')]:
            with self.subTest(phase=phase):
                content = json.loads((path / 'status.json').read_text())
                content['phase'] = phase
                (path / 'status.json').write_text(json.dumps(content))
                os.utime(path / 'status.json', (self.now - 10, self.now - 10))
                result = demo.deployment(self.root, {}, self.now)
                self.assertEqual(result['status'], expected)
                self.assertNotIn('secret', json.dumps(result))
        self.assertEqual(demo.deployment(self.root, {'max_deploy_age_seconds': 5}, self.now)['status'], 'failed')

    def test_empty_new_request_cannot_hide_behind_previous_success(self):
        self.deploy('succeeded')
        new = self.root / '.clockwork/requests' / ('d' * 64)
        new.mkdir()
        os.utime(new, (self.now + 1, self.now + 1))
        self.assertEqual(demo.observe(demo.deployment, self.root, {}, self.now), {'status': 'unknown'})

    def test_invalid_or_future_deploy_state_is_not_green(self):
        path = self.deploy('succeeded', age=-10)
        self.assertEqual(demo.observe(demo.deployment, self.root, {}, self.now), {'status': 'unknown'})
        (path / 'status.json').write_text('{truncated secret')
        self.assertEqual(demo.observe(demo.deployment, self.root, {}, self.now), {'status': 'unknown'})

    def test_dump_presence_catalog_check_and_restoration_are_separate_facts(self):
        path = self.backup(complete=False)
        result = demo.backups(self.root, {}, self.now, False)
        self.assertTrue(result['latest_attempt']['dump_present'])
        self.assertEqual(result['latest_attempt']['status'], 'incomplete')
        self.assertEqual(result['last_restore'], {'status': 'unknown'})
        (path / 'complete').write_bytes(b'verified dump archive\n')
        result = demo.backups(self.root, {}, self.now, False)
        self.assertEqual(result['latest_completed']['catalog_check'], 'verified_at_creation')
        self.assertEqual(result['last_restore']['status'], 'unknown')

    def test_new_partial_backup_does_not_erase_last_completed_backup(self):
        self.backup('1')
        self.backup('2', complete=False)
        result = demo.backups(self.root, {'max_backup_age_seconds': 50}, self.now, False)
        self.assertEqual(result['latest_attempt']['status'], 'incomplete')
        self.assertEqual(result['latest_completed']['status'], 'failed')
        self.assertTrue(result['latest_completed']['dump_present'])

    def test_new_untested_dump_keeps_separate_last_restore_date(self):
        old = self.backup('1')
        self.receipt(old)
        self.backup('2')
        result = demo.backups(self.root, {'max_restore_age_seconds': 100}, self.now, True)
        self.assertEqual(result['last_restore']['status'], 'ok')
        self.assertTrue(result['last_restore']['digest_checked'])
        self.assertEqual(result['last_restore']['evidence'], 'operator_attested_restore')

    def test_last_restore_is_chosen_by_test_date_not_dump_creation_order(self):
        old = self.backup('1')
        self.receipt(old, age=10)
        new = self.backup('2')
        self.receipt(new, age=50)
        result = demo.backups(self.root, {'max_restore_age_seconds': 20}, self.now, True)
        self.assertEqual(result['last_restore']['status'], 'ok')
        self.assertLessEqual(result['last_restore']['age_seconds'], 11)
        self.assertTrue(result['last_restore']['digest_checked'])

    def test_routine_poll_does_not_hash_dumps_or_claim_verified_restore(self):
        path = self.backup()
        self.receipt(path)
        with patch.object(demo.hashlib, 'sha256', side_effect=AssertionError('must not hash')):
            result = demo.backups(self.root, {}, self.now, False)
        self.assertEqual(result['last_restore']['status'], 'recorded')
        self.assertFalse(result['last_restore']['digest_checked'])

    def test_changed_dump_invalidates_restore_evidence(self):
        path = self.backup()
        self.receipt(path)
        (path / 'database.dump').write_bytes(b'changed fixture')
        os.utime(path / 'database.dump', (self.now - 100, self.now - 100))
        self.assertEqual(demo.backups(self.root, {}, self.now, True)['last_restore']['status'], 'failed')

    def test_old_restore_and_future_or_impossible_receipts(self):
        path = self.backup()
        self.receipt(path)
        for verify in [False, True]:
            with self.subTest(verify=verify):
                self.assertEqual(demo.backups(self.root, {'max_restore_age_seconds': 10}, self.now, verify)['last_restore']['status'], 'failed')
        for age in [-100, 200]:
            with self.subTest(age=age):
                self.receipt(path, age=age)
                self.assertEqual(demo.backups(self.root, {}, self.now, True)['last_restore']['status'], 'unknown')

    def test_empty_and_symlink_dumps_cannot_be_completed_backups(self):
        path = self.backup()
        (path / 'database.dump').write_bytes(b'')
        os.utime(path / 'database.dump', (self.now - 100, self.now - 100))
        self.assertEqual(demo.backups(self.root, {}, self.now, True)['latest_attempt']['status'], 'incomplete')
        (path / 'database.dump').unlink()
        (path / 'database.dump').symlink_to('/etc/passwd')
        self.assertEqual(demo.backups(self.root, {}, self.now, True)['latest_attempt']['status'], 'unknown')

    def test_inventory_limit_and_symlink_directories_fail_closed(self):
        root = self.root / 'inventory'
        root.mkdir()
        for n in range(1001):
            (root / str(n)).touch()
        self.assertEqual(demo.observe(demo.candidates, root, '.*'), {'status': 'unknown'})
        link = self.root / 'linked'
        link.symlink_to(root, target_is_directory=True)
        self.assertEqual(demo.observe(demo.candidates, link, '.*'), {'status': 'unknown'})

    def test_explicit_hash_has_a_time_budget(self):
        path = self.backup()
        self.receipt(path)
        with patch.object(demo.time, 'monotonic', side_effect=[0, 31]):
            result = demo.backups(self.root, {}, self.now, True)
        self.assertEqual(result['last_restore']['status'], 'unknown')

    def test_changed_dump_during_hash_is_not_confirmed(self):
        path = self.backup()
        self.receipt(path)
        original = os.fstat
        count = 0
        def fstat(fd):
            nonlocal count
            result = original(fd)
            if result.st_size == len(b'isolated fixture dump'):
                count += 1
                if count == 2:
                    return SimpleNamespace(st_ino=result.st_ino, st_size=result.st_size + 1,
                                           st_mtime_ns=result.st_mtime_ns)
            return result
        with patch.object(demo.os, 'fstat', side_effect=fstat):
            result = demo.backups(self.root, {}, self.now, True)
        self.assertEqual(result['last_restore']['status'], 'failed')

    def test_malformed_state_types_and_deep_json_do_not_crash_the_collector(self):
        for item in [None, [], 'secret', 42]:
            with self.subTest(item=item), patch.object(demo, 'docker_json', return_value=item):
                self.assertEqual(demo.observe(demo.container, 'db', 'db', 'erp'), {'status': 'unknown'})
                self.assertEqual(demo.observe(demo.runtime_version, 'c' * 64, 'frontend'), {'status': 'unknown'})
        self.assertEqual(demo.observe(demo.decode_json, '[' * 3000 + '0' + ']' * 3000), {'status': 'unknown'})

    def test_enabled_cli_preserves_state_and_excludes_sensitive_state_fields(self):
        self.backup()
        self.deploy('failed')
        self.config['disks'] = {'backups': str(self.root / '.clockwork/backups')}
        config = self.root / 'config.json'
        config.write_text(json.dumps(self.config))
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(demo.main(['--config', str(config)]), 1)
        report = json.loads(out.getvalue())
        self.assertEqual(report['deploy']['phase'], 'failed')
        self.assertEqual(report['backup']['latest_completed']['catalog_check'], 'verified_at_creation')
        self.assertGreater(report['disks']['backups']['available_bytes'], 0)
        self.assertNotIn('secret', out.getvalue())
        self.assertNotIn(str(self.root), out.getvalue())
        self.assertEqual(before, {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_exit_codes_do_not_treat_missing_policy_or_data_as_healthy(self):
        for state in ['unknown', 'observed', 'recorded', 'not_configured', 'in_progress']:
            with self.subTest(state=state):
                self.assertEqual(demo.exit_code({'nested': {'status': state}}), 2)
        self.assertEqual(demo.exit_code({'nested': {'status': 'ok'}}), 0)
        self.assertEqual(demo.exit_code({'nested': {'status': 'incomplete'}}), 1)
        self.assertEqual(demo.exit_code({'nested': {'status': 'failed'}}), 1)


@unittest.skipUnless(os.environ.get('CLOCKWORK_DEMO_DOCKER_TESTS') == '1', 'opt-in isolated demo PostgreSQL check')
class DemoDockerTest(unittest.TestCase):
    setUp = DemoTest.setUp
    backup = DemoTest.backup
    receipt = DemoTest.receipt

    def test_real_db_health_dump_catalog_restore_and_database_outage(self):
        name = 'clockwork-demo-test-' + uuid.uuid4().hex
        def docker(*args, stdin=None, check=True):
            result = subprocess.run(['docker', *args], input=stdin, capture_output=True,
                                    check=check, timeout=30)
            return result.stdout
        docker('image', 'inspect', 'postgres:16-alpine')
        self.addCleanup(lambda: docker('rm', '-f', '-v', name, check=False))
        docker('run', '-d', '--pull', 'never', '--name', name, '--network', 'none',
               '--tmpfs', '/var/lib/postgresql/data',
               '--label', 'com.docker.compose.project=' + name,
               '--label', 'com.docker.compose.service=db',
               '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=fixture',
               '-e', 'POSTGRES_DB=fixture', '--health-cmd', 'pg_isready -U fixture -d fixture',
               '--health-interval', '1s', '--health-timeout', '1s', '--health-retries', '20',
               'postgres:16-alpine')
        for _ in range(100):
            state = demo.observe(demo.container, name, 'db', name)
            if state['status'] == 'ok':
                break
            time.sleep(0.1)
        else:
            self.fail('Isolated PostgreSQL did not become healthy')
        def sql(query):
            return docker('exec', name, 'psql', '-U', 'fixture', '-d', 'fixture',
                          '-v', 'ON_ERROR_STOP=1', '-Atc', query)
        meminfo = self.root / 'linux-meminfo'
        meminfo.write_bytes(docker('exec', name, 'cat', '/proc/meminfo'))
        self.assertGreater(demo.memory({}, meminfo)['available_bytes'], 0)
        self.assertGreater(demo.disk(str(self.root), {})['available_bytes'], 0)
        sql("CREATE TABLE demo_fixture (id integer PRIMARY KEY, value text); "
            "INSERT INTO demo_fixture VALUES (1,'restore-fixture');")
        path = self.backup(complete=False)
        dump = docker('exec', name, 'pg_dump', '-U', 'fixture', '-d', 'fixture', '-Fc')
        (path / 'database.dump').write_bytes(dump)
        docker('exec', '-i', name, 'pg_restore', '--list', stdin=dump)
        (path / 'complete').write_bytes(b'verified dump archive\n')
        result = demo.backups(self.root, {}, time.time(), False)
        self.assertEqual(result['latest_completed']['catalog_check'], 'verified_at_creation')
        self.assertEqual(result['last_restore'], {'status': 'unknown'})
        sql('DROP TABLE demo_fixture')
        docker('exec', '-i', name, 'pg_restore', '-U', 'fixture', '-d', 'fixture',
               '--exit-on-error', stdin=dump)
        self.assertEqual(sql('SELECT id, value FROM demo_fixture'), b'1|restore-fixture\n')
        receipt = {'schema': 1, 'dump_sha256': hashlib.sha256(dump).hexdigest(),
                   'restored_at': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
                   'result': 'restored_and_checked'}
        (path / 'restore-test.json').write_text(json.dumps(receipt))
        result = demo.backups(self.root, {'max_backup_age_seconds': 60, 'max_restore_age_seconds': 60}, time.time(), True)
        self.assertEqual(result['last_restore']['status'], 'ok')
        self.assertTrue(result['last_restore']['digest_checked'])
        self.assertNotIn('restore-fixture', json.dumps(result))
        # Stopping only this UUID fixture proves DB failure without SQL credentials in the checker.
        docker('stop', '--time', '3', name)
        self.assertEqual(demo.container(name, 'db', name)['status'], 'failed')
