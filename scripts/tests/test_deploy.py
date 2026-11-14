import base64
import contextlib
import copy
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy.py'
SPEC = importlib.util.spec_from_file_location('deploy', SCRIPT)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
REPO = SCRIPT.parent.parent
ENV = {key: key.lower() + '-test' for key in deploy.REQUIRED_ENV}
ENV['JWT_SECRET_KEY'] = 'test-signing-key-01234567890123456789'


class FilesystemTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()

    def test_create_missing_directories_without_changing_existing_data(self):
        target = deploy.directory(self.root / 'a' / 'b')
        (target / 'data').write_text('keep me')
        deploy.directory(target)
        self.assertEqual((target / 'data').read_text(), 'keep me')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)

    def test_symlinks_at_every_level_are_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'file').write_text('original')
        (self.root / 'link').symlink_to(outside, target_is_directory=True)
        for action in (lambda: deploy.directory(self.root / 'link' / 'child'),
                       lambda: deploy.atomic_write(self.root / 'link' / 'file', b'changed')):
            with self.subTest(action=action), self.assertRaises(deploy.DeployError):
                action()
        self.assertEqual((outside / 'file').read_text(), 'original')
        (self.root / 'dangling').symlink_to(self.root / 'missing')
        with self.assertRaises(deploy.DeployError):
            deploy.atomic_write(self.root / 'dangling', b'changed')

    def test_atomic_write_is_private_and_noop_preserves_inode_and_timestamp(self):
        target = self.root / 'secret'
        self.assertTrue(deploy.atomic_write(target, b'secret'))
        before = target.stat()
        self.assertFalse(deploy.atomic_write(target, b'secret'))
        self.assertEqual((before.st_ino, before.st_mtime_ns),
                         (target.stat().st_ino, target.stat().st_mtime_ns))
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

    def test_failed_atomic_replace_preserves_previous_file(self):
        target = self.root / 'compose.yml'
        target.write_bytes(b'previous')
        with patch.object(deploy.os, 'replace', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                deploy.atomic_write(target, b'candidate')
        self.assertEqual(target.read_bytes(), b'previous')
        self.assertEqual(list(self.root.iterdir()), [target])

    def test_directory_file_collision_fails_without_deleting_file(self):
        target = self.root / 'collision'
        target.write_text('data')
        with self.assertRaises(FileExistsError):
            deploy.directory(target)
        self.assertEqual(target.read_text(), 'data')


class InputTest(unittest.TestCase):
    def test_environment_json_and_url_encoding_preserve_special_characters(self):
        env = dict(ENV, DATABASE_USER='user@host', DATABASE_PASSWORD='a$${x}"\n\' :/?!% é',
                   DATABASE_NAME='db/name', ADMIN_PASSWORD='line1\nline2')
        result = deploy.app_environment(json.dumps(env))
        self.assertEqual(result['DATABASE_PASSWORD'], env['DATABASE_PASSWORD'])
        self.assertIn('user%40host:', result['DATABASE_URL'])
        self.assertIn('/db%2Fname?', result['DATABASE_URL'])
        self.assertNotIn('\n', result['DATABASE_URL'])
        self.assertEqual(result['JWT_REFRESH_KEY'], '')

    def test_bad_environment_fails_without_exposing_values(self):
        for raw in ('invalid', '[]', '{}', json.dumps(dict(ENV, JWT_SECRET_KEY=7)),
                    json.dumps(dict(ENV, UNKNOWN='hidden-secret')),
                    json.dumps(dict(ENV, ADMIN_PASSWORD='nul\0hidden-secret'))):
            with self.subTest(raw=raw), self.assertRaises(deploy.DeployError) as caught:
                deploy.app_environment(raw)
            self.assertNotIn('hidden-secret', str(caught.exception))

    def test_signing_key_length_matches_backend_utf8_byte_limit(self):
        for key, accepted in [('x' * 31, False), ('x' * 32, True), ('é' * 15, False), ('é' * 16, True)]:
            with self.subTest(byte_count=len(key.encode())):
                if accepted:
                    self.assertEqual(deploy.app_environment(json.dumps(dict(ENV, JWT_SECRET_KEY=key)))['JWT_SECRET_KEY'], key)
                else:
                    with self.assertRaises(deploy.DeployError) as caught:
                        deploy.app_environment(json.dumps(dict(ENV, JWT_SECRET_KEY=key)))
                    self.assertNotIn(key, str(caught.exception))

    def test_unknown_template_key_fails_closed(self):
        with self.assertRaises(deploy.DeployError):
            deploy.render('image: ${TYPO}', {})

    def test_versions_are_canonical_and_moving_tags_are_forbidden(self):
        for version in ('stable', 'latest', '1.2.3', 'v01.2.3', 'v1.2.3-rc.1', 'v1.2.3\n'):
            with self.subTest(version=version), self.assertRaises(deploy.DeployError):
                deploy.pinned_image('koshsky/erp-backend', version)

    def test_ssh_rejects_option_injection_wrong_user_and_invalid_port(self):
        for updates in ({'DEPLOY_HOST': '-oProxyCommand=bad'}, {'DEPLOY_USER': 'user'},
                        {'DEPLOY_PORT': '0'}, {'DEPLOY_PORT': '65536'}, {'DEPLOY_PORT': '22;id'}):
            env = dict(DEPLOY_HOST='erp.koshsky.ru', DEPLOY_USER='root', **{})
            env.update(updates)
            with self.subTest(updates=updates), self.assertRaises(deploy.DeployError):
                deploy.ssh_command(env, '/key', '/hosts')
        cmd = deploy.ssh_command(dict(DEPLOY_HOST='erp.koshsky.ru', DEPLOY_USER='root'), '/key', '/hosts')
        self.assertIn('StrictHostKeyChecking=yes', cmd)
        self.assertIn('IdentityAgent=none', cmd)
        self.assertNotIn('StrictHostKeyChecking=no', cmd)

    def test_command_errors_never_expose_interpolated_secrets(self):
        error = subprocess.CalledProcessError(1, ['docker'], stderr=b'password=do-not-print')
        with patch.object(deploy.subprocess, 'Popen', side_effect=error):
            with self.assertRaises(deploy.DeployError) as caught:
                deploy.command(['docker', 'compose', 'config'])
        self.assertNotIn('do-not-print', str(caught.exception))

    def test_command_treats_shell_metacharacters_as_literal_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'must-not-exist'
            argument = '$(touch ' + str(marker) + '); echo injected'
            output = deploy.command([sys.executable, '-c', 'import sys; print(sys.argv[1])', argument])
            self.assertEqual(output.decode().strip(), argument)
            self.assertFalse(marker.exists())

    def test_dump_verification_streams_input_instead_of_reading_entire_dump(self):
        with tempfile.TemporaryFile() as stream:
            process = Mock(returncode=0)
            process.communicate.return_value = (b'', b'')
            with patch.object(deploy.subprocess, 'Popen', return_value=process) as popen:
                deploy.command(['docker', 'exec'], stdin=stream)
            self.assertIs(popen.call_args.kwargs['stdin'], stream)
            self.assertIsNone(process.communicate.call_args.args[0])

    def test_timeout_terminates_compose_process_group_before_returning_failure(self):
        process = Mock(pid=12345)
        process.communicate.side_effect = [subprocess.TimeoutExpired(['docker'], 1), (b'', b'private')]
        with patch.object(deploy.subprocess, 'Popen', return_value=process) as popen, \
                patch.object(deploy.os, 'killpg') as kill:
            with self.assertRaises(deploy.DeployError):
                deploy.command(['docker', 'compose', 'up'], timeout=1)
        kill.assert_called_once_with(12345, deploy.signal.SIGKILL)
        self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertEqual(process.communicate.call_count, 2)

    def test_image_resolution_requires_linux_digest_from_correct_repository(self):
        image = {'Architecture': 'amd64', 'Os': 'linux',
                 'RepoDigests': ['koshsky/erp-backend@sha256:' + 'a' * 64]}
        with patch.object(deploy, 'command'), patch.object(deploy, 'docker_json', return_value=[image]):
            self.assertEqual(deploy.pinned_image('koshsky/erp-backend', 'v1.5.0'), image['RepoDigests'][0])
        for changed in ({'Architecture': 'arm64'}, {'Os': 'windows'},
                        {'RepoDigests': ['evil/backend@sha256:' + 'a' * 64]}, {'RepoDigests': []}):
            with self.subTest(changed=changed), patch.object(deploy, 'command'), \
                    patch.object(deploy, 'docker_json', return_value=[dict(image, **changed)]):
                with self.assertRaises(deploy.DeployError):
                    deploy.pinned_image('koshsky/erp-backend', 'v1.5.0')


def containers(env):
    result = {}
    for name in deploy.SERVICES:
        result[name] = {'Id': name + '-id', 'Image': name + '-image',
                        'Mounts': [{'Type': 'volume', 'Name': volume, 'Destination': target}
                                   for target, volume in deploy.MOUNTS.get(name, {}).items()],
                        'NetworkSettings': {'Networks': {'erp_app-network': {'IPAddress': deploy.PROXY_IP if name == 'caddy' else '172.18.0.9'}}},
                        'Config': {'Env': [], 'Labels': {'com.docker.compose.config-hash': name}},
                        'State': {'Running': True}}
    result['db']['Config']['Env'] = ['PGDATA=' + deploy.PGDATA, 'POSTGRES_DB=' + env['DATABASE_NAME'],
                                    'POSTGRES_USER=' + env['DATABASE_USER'],
                                    'POSTGRES_PASSWORD=' + env['DATABASE_PASSWORD']]
    return result


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.containers = containers(ENV)
        def command(args, **kwargs):
            if args[1] == 'ps':
                return (args[-1].split('=')[-1] + '-id').encode()
            return b'1\n'
        self.command = patch.object(deploy, 'command', side_effect=command).start()
        self.addCleanup(patch.stopall)
        self.json = patch.object(deploy, 'docker_json', side_effect=self.json_call).start()

    def json_call(self, *args):
        if args[0] == 'inspect':
            return [self.containers[args[1].removesuffix('-id')]]
        if args[:2] == ('volume', 'inspect'):
            return [{'Driver': 'local', 'Options': None, 'Mountpoint': '/volume/' + args[2]}]
        return [{'IPAM': {'Config': [{'Subnet': '172.18.0.0/16', 'Gateway': '172.18.0.1'}]},
                 'Containers': {'caddy-id': {'IPv4Address': deploy.PROXY_IP + '/16'}}}]

    def test_exact_existing_volumes_and_credentials_are_accepted(self):
        actual, mounts = deploy.inspect_stack(ENV)
        self.assertEqual(actual, self.containers)
        self.assertEqual(set(mounts), {v for m in deploy.MOUNTS.values() for v in m.values()})

    def test_wrong_volume_or_bind_instead_of_volume_is_rejected(self):
        for field, value in (('Name', 'erp_db_data'), ('Type', 'bind')):
            with self.subTest(field=field):
                original = copy.deepcopy(self.containers)
                self.containers['db']['Mounts'][0][field] = value
                with self.assertRaises(deploy.DeployError):
                    deploy.inspect_stack(ENV)
                self.containers = original

    def test_missing_external_volume_fails_before_any_compose_up(self):
        def inspect(*args):
            if args[:2] == ('volume', 'inspect'):
                raise deploy.DeployError('missing volume')
            return self.json_call(*args)
        self.json.side_effect = inspect
        with self.assertRaises(deploy.DeployError):
            deploy.inspect_stack(ENV)
        self.assertFalse(any('compose' in c.args[0] for c in self.command.call_args_list))

    def test_database_credential_changes_are_not_silent_rotations(self):
        for key in ('DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'):
            with self.subTest(key=key), self.assertRaises(deploy.DeployError):
                deploy.inspect_stack(dict(ENV, **{key: 'new-value'}))

    def test_custom_or_missing_pgdata_is_rejected_before_reading_database(self):
        for value in ('/var/lib/postgresql/data/custom', None):
            original = self.containers['db']['Config']['Env']
            self.containers['db']['Config']['Env'] = [e for e in original if not e.startswith('PGDATA=')]
            if value is not None:
                self.containers['db']['Config']['Env'].append('PGDATA=' + value)
            self.command.reset_mock()
            with self.subTest(value=value), self.assertRaises(deploy.DeployError):
                deploy.inspect_stack(ENV)
            self.assertFalse(any(c.args[0][1] == 'exec' for c in self.command.call_args_list))
            self.containers['db']['Config']['Env'] = original

    def test_reserved_proxy_ip_cannot_belong_to_another_container(self):
        original = self.json_call
        def inspect(*args):
            result = original(*args)
            if args[:2] == ('network', 'inspect'):
                result[0]['Containers'] = {'foreign-id': {'IPv4Address': deploy.PROXY_IP + '/16'}}
            return result
        self.json.side_effect = inspect
        with self.assertRaises(deploy.DeployError):
            deploy.inspect_stack(ENV)

    def test_unexpected_network_is_rejected(self):
        self.containers['erp']['NetworkSettings']['Networks'] = {'other': {}}
        with self.assertRaises(deploy.DeployError):
            deploy.inspect_stack(ENV)


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.addCleanup(patch.stopall)
        patch.object(deploy, 'ROOT', self.root).start()
        self.request = deploy.directory(self.root / '.clockwork/requests' / ('a' * 64))
        self.payload = {'source': 'b' * 40, 'environment': json.dumps(ENV),
                        'backend': 'v1.5.0', 'frontend': 'v2.0.0',
                        'files': {f: (REPO / 'deploy/production' / f).read_text() for f in deploy.FILES}}
        (self.request / 'payload.json').write_bytes(deploy.encoded(self.payload))
        self.active = self.root / 'docker-compose.yml'
        self.active.write_text('old compose')
        self.old = containers(ENV)
        self.old['loki']['Config']['Labels']['com.docker.compose.config-hash'] = 'c' * 64
        self.new = copy.deepcopy(self.old)
        self.new['erp']['Image'] = 'new-backend'
        self.new['frontend']['Image'] = 'new-frontend'
        self.new['erp']['Id'] = 'new-erp-id'
        self.new['frontend']['Id'] = 'new-frontend-id'
        self.current = self.old
        self.events = []
        self.model = {'services': {n: {'image': n + '@sha256:' + 'c' * 64} for n in ('db', 'caddy', 'loki')}}
        self.fail = None
        self.inventory = patch.object(deploy, 'inspect_stack', side_effect=lambda env: (self.current, {})).start()
        self.pinned = patch.object(deploy, 'pinned_image', side_effect=lambda repo, version: repo + '@sha256:' + 'd' * 64).start()
        self.compose = patch.object(deploy, 'compose', side_effect=self.compose_call).start()
        self.validate = patch.object(deploy, 'validate_model', side_effect=self.validate_call).start()
        patch.object(deploy, 'backup_budget', return_value=deploy.SPACE_RESERVE).start()
        self.loki = patch.object(deploy, 'wait_loki', side_effect=self.wait_loki_call).start()
        self.backup = patch.object(deploy, 'backup', side_effect=self.backup_call).start()
        self.ready = patch.object(deploy, 'ready', side_effect=lambda *args: self.events.append('ready')).start()
        patch.object(deploy, 'command', side_effect=self.command_call).start()
        patch.object(deploy.shutil, 'disk_usage', return_value=Mock(free=10 * 1024 ** 3)).start()
        patch.object(deploy, 'docker_json', side_effect=lambda *a: [{'Id': 'new-backend' if 'backend' in a[-1] else 'new-frontend', 'Config': {'Env': ['PG_MAJOR=16']}}]).start()

    def validate_call(self, model):
        self.events.append('validate-model')
        if self.fail == 'model':
            raise deploy.DeployError('invalid topology')

    def wait_loki_call(self, image):
        self.events.append('loki-ready')
        if self.fail == 'loki':
            raise deploy.DeployError('Loki is not ready')

    def command_call(self, args, **kwargs):
        if args[1] == 'run':
            self.events.append('validate-container')
            if self.fail == 'validator':
                raise deploy.DeployError('simulated validator failure')
        return b'1024'

    def compose_call(self, path, *args, **kwargs):
        self.events.append(args[0])
        if args[0] == self.fail:
            raise deploy.DeployError('simulated ' + self.fail + ' failure')
        if args[0] == 'up' and args[-1] != 'loki':
            self.current = self.new
        if args[0] == 'config' and '--hash' in args:
            return ('loki ' + 'c' * 64).encode()
        if args[0] == 'config':
            return deploy.encoded(self.model)
        return b''

    def backup_call(self, *args):
        self.events.append('backup')
        if self.fail == 'backup':
            raise deploy.DeployError('simulated backup failure')

    def status(self):
        return json.loads((self.request / 'status.json').read_text())

    def test_apply_orders_validation_backup_activation_and_readiness(self):
        deploy.apply(self.request)
        self.assertEqual(self.events, ['config', 'validate-model', 'pull', 'validate-container', 'validate-container', 'backup', 'config', 'up', 'loki-ready', 'up', 'ready'])
        self.validate.assert_called_once_with(self.model)
        self.assertEqual(self.status()['phase'], 'succeeded')
        self.assertEqual((self.request / 'previous-compose.yml').read_text(), 'old compose')
        self.assertEqual(self.active.read_bytes(), (self.request / 'compose.yml').read_bytes())
        args = next(c.args[1:] for c in self.compose.call_args_list if c.args[1] == 'up')
        self.assertIn('--no-build', args)
        self.assertIn('--wait', args)
        self.assertNotIn('--force-recreate', args)
        self.assertNotIn('--remove-orphans', args)

    def test_repeat_success_does_not_backup_pull_or_recreate_containers(self):
        deploy.apply(self.request)
        self.events.clear()
        self.pinned.reset_mock()
        before = self.active.stat().st_mtime_ns
        deploy.apply(self.request)
        self.assertEqual(self.events, ['config', 'validate-model', 'ready'])
        self.pinned.assert_not_called()
        self.assertEqual(self.active.stat().st_mtime_ns, before)
        self.assertEqual(self.status()['phase'], 'succeeded')

    def test_config_only_change_changes_only_its_bind_source(self):
        deploy.apply(self.request)
        before = (self.request / 'compose.yml').read_text()
        self.payload['files']['backend.yaml'] += '\n# changed config\n'
        (self.request / 'payload.json').write_bytes(deploy.encoded(self.payload))
        self.events.clear()
        deploy.apply(self.request)
        after = (self.request / 'compose.yml').read_text()
        before_lines, after_lines = before.splitlines(), after.splitlines()
        changed = [(a, b) for a, b in zip(before_lines, after_lines) if a != b]
        self.assertEqual(len(changed), 1)
        self.assertIn('backend.yaml', changed[0][0])
        self.assertIn('up', self.events)

    def test_secret_only_change_is_applied_and_existing_volumes_stay_external(self):
        deploy.apply(self.request)
        self.payload['environment'] = json.dumps(dict(ENV, ADMIN_PASSWORD='new$secret'))
        (self.request / 'payload.json').write_bytes(deploy.encoded(self.payload))
        self.events.clear()
        deploy.apply(self.request)
        self.assertIn('up', self.events)
        self.assertIn('new$$secret', self.active.read_text())
        self.assertEqual(self.active.read_text().count('external: true'), 5)

    def test_failure_before_activation_preserves_old_compose(self):
        for failure in ('config', 'model', 'pull', 'validator', 'backup'):
            with self.subTest(failure=failure):
                self.fail = failure
                self.events.clear()
                with self.assertRaises(deploy.DeployError):
                    deploy.apply(self.request)
                self.assertEqual(self.active.read_text(), 'old compose')
                self.assertNotIn('up', self.events)
                self.assertEqual(self.status()['phase'], 'failed')

    def test_up_failure_can_resume_without_reresolving_or_losing_previous_compose(self):
        self.fail = 'up'
        with self.assertRaises(deploy.DeployError):
            deploy.apply(self.request)
        self.assertEqual(self.status()['phase'], 'failed')
        self.fail = None
        self.pinned.reset_mock()
        deploy.apply(self.request)
        self.pinned.assert_not_called()
        self.assertEqual(self.status()['phase'], 'succeeded')
        self.assertEqual((self.request / 'previous-compose.yml').read_text(), 'old compose')

    def test_readiness_failure_never_restores_database_or_claims_success(self):
        self.ready.side_effect = deploy.DeployError('public health failed')
        with self.assertRaises(deploy.DeployError):
            deploy.apply(self.request)
        self.assertEqual(self.status()['phase'], 'failed')
        self.assertFalse((self.root / '.clockwork/applied.json').exists())
        self.assertFalse(any('restore' in event or event == 'down' for event in self.events))

    def test_loki_change_pauses_traffic_before_infrastructure_and_resumes_after_ready(self):
        self.old['loki']['Config']['Labels']['com.docker.compose.config-hash'] = 'old-config'
        deploy.apply(self.request)
        operations = [c.args[1:] for c in self.compose.call_args_list]
        stop_caddy = next(i for i, a in enumerate(operations) if a[0] == 'stop' and a[-1] == 'caddy')
        stop_backend = next(i for i, a in enumerate(operations) if a[0] == 'stop' and a[-1] == 'erp')
        infra_up = next(i for i, a in enumerate(operations) if a[0] == 'up' and a[-1] == 'loki')
        self.assertLess(stop_caddy, stop_backend)
        self.assertLess(stop_backend, infra_up)
        self.assertLess(self.events.index('backup'), self.events.index('stop'))
        self.assertEqual(self.events[-4:], ['up', 'loki-ready', 'up', 'ready'])

    def test_unready_loki_cannot_start_application_or_report_success(self):
        self.old['loki']['Config']['Labels']['com.docker.compose.config-hash'] = 'old-config'
        self.fail = 'loki'
        with self.assertRaises(deploy.DeployError):
            deploy.apply(self.request)
        up_calls = [c.args[1:] for c in self.compose.call_args_list if c.args[1] == 'up']
        self.assertEqual(len(up_calls), 1)
        self.assertEqual(up_calls[0][-2:], ('db', 'loki'))
        self.ready.assert_not_called()
        self.assertEqual(self.status()['phase'], 'failed')
        self.fail = None
        deploy.apply(self.request)
        self.assertEqual(self.status()['phase'], 'succeeded')

    def test_unchanged_loki_is_not_stopped_on_application_update(self):
        deploy.apply(self.request)
        self.assertFalse(any(c.args[1] == 'stop' for c in self.compose.call_args_list))
        self.loki.assert_called_once()

    def test_running_image_mismatch_is_a_failed_deployment(self):
        self.new['erp']['Image'] = 'wrong-image'
        with self.assertRaises(deploy.DeployError):
            deploy.apply(self.request)
        self.assertEqual(self.status()['phase'], 'failed')
        self.ready.assert_not_called()

    def test_stopped_or_unhealthy_service_cannot_be_reported_as_success(self):
        for service, state in [('loki', {'Running': False}),
                               ('erp', {'Running': True, 'Health': {'Status': 'unhealthy'}})]:
            original = copy.deepcopy(self.new)
            self.new[service]['State'] = state
            with self.subTest(service=service), self.assertRaises(deploy.DeployError):
                deploy.apply(self.request)
            self.assertEqual(self.status()['phase'], 'failed')
            self.ready.assert_not_called()
            self.new = original

    def test_insufficient_disk_fails_before_pull_and_backup(self):
        with patch.object(deploy.shutil, 'disk_usage', return_value=Mock(free=100)):
            with self.assertRaises(deploy.DeployError):
                deploy.apply(self.request)
        self.assertEqual(self.events, [])
        self.assertEqual(self.active.read_text(), 'old compose')

    def test_insufficient_ancillary_budget_fails_before_backup_or_traffic_pause(self):
        with patch.object(deploy, 'backup_budget', return_value=20 * 1024 ** 3):
            with self.assertRaises(deploy.DeployError):
                deploy.apply(self.request)
        self.backup.assert_not_called()
        self.assertNotIn('stop', self.events)
        self.assertNotIn('up', self.events)
        self.assertEqual(self.active.read_text(), 'old compose')

    def test_server_lock_rejects_concurrent_deployment(self):
        with (self.root / '.clockwork/deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(deploy.DeployError):
                deploy.apply(self.request)
        self.assertEqual(self.events, [])
        self.assertEqual(self.active.read_text(), 'old compose')

    def test_same_images_with_runtime_drift_are_reconciled(self):
        deploy.apply(self.request)
        self.current['erp']['Id'] = 'unexpected-recreated-container'
        self.events.clear()
        deploy.apply(self.request)
        self.assertIn('up', self.events)
        self.assertIn('backup', self.events)

    def test_invalid_request_path_is_rejected(self):
        with self.assertRaises(deploy.DeployError):
            deploy.apply(self.root)


class ReceiveTest(unittest.TestCase):
    def test_detached_worker_has_private_files_and_no_ssh_descriptors(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(deploy, 'ROOT', Path(tmp).resolve()), \
                patch.object(deploy.subprocess, 'Popen', return_value=Mock(pid=999999)) as popen:
            payload = {'script': base64.b64encode(b'worker-source').decode(), 'environment': 'private'}
            with contextlib.redirect_stdout(io.StringIO()) as output:
                deploy.receive(payload)
            request = deploy.ROOT / '.clockwork/requests' / output.getvalue().strip()
            self.assertEqual((request / 'deploy.py').read_bytes(), b'worker-source')
            self.assertEqual(stat.S_IMODE((request / 'payload.json').stat().st_mode), 0o600)
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
            self.assertTrue(popen.call_args.kwargs['close_fds'])
            self.assertEqual(popen.call_args.kwargs['stdin'], subprocess.DEVNULL)
            self.assertIs(popen.call_args.kwargs['shell'], False)
            stdout = popen.call_args.kwargs['stdout']
            self.assertIs(popen.call_args.kwargs['stderr'], stdout)
            self.assertEqual(Path(stdout.name), request / 'private.log')
            self.assertEqual(stat.S_IMODE(Path(stdout.name).stat().st_mode), 0o600)


@unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI is required for template integration')
class ComposeIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.env = dict(ENV, DATABASE_PASSWORD='a$${var}"\n\' :/? é',
                       ADMIN_PASSWORD='before\nafter$with"quotes')
        values = dict(deploy.app_environment(json.dumps(cls.env)),
                      BACKEND_IMAGE='koshsky/erp-backend@sha256:' + 'a' * 64,
                      FRONTEND_IMAGE='koshsky/erp-frontend@sha256:' + 'b' * 64,
                      CUSTOM_ASSETS='/opt/erp/assets/custom',
                      BACKEND_CONFIG='/opt/erp/.clockwork/configs/a/backend.yaml',
                      CADDY_CONFIG='/opt/erp/.clockwork/configs/b/Caddyfile',
                      LOKI_CONFIG='/opt/erp/.clockwork/configs/c/loki.yaml')
        template = (REPO / 'deploy/production/compose.yml').read_text()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'compose.yml'
            path.write_bytes(deploy.render(template, values))
            result = subprocess.run(['docker', 'compose', '--env-file', '/dev/null', '-f', str(path),
                                     'config', '--format', 'json'], capture_output=True, check=True)
        cls.model = json.loads(result.stdout)

    def test_proxy_trust_is_limited_to_the_reserved_caddy_address(self):
        text = (REPO / 'deploy/production/backend.yaml').read_text()
        lines = text.split('  trusted_proxies:\n', 1)[1].split('\n\n', 1)[0].splitlines()
        trusted = [line.strip()[2:] for line in lines if line.strip().startswith('- ')]
        address = self.model['services']['caddy']['networks']['app-network']['ipv4_address']
        self.assertEqual(trusted, [address + '/32'])
        self.assertEqual(address, deploy.PROXY_IP)

    def test_real_compose_preserves_secret_values_and_literal_shell_variables(self):
        model = self.model
        deploy.validate_model(model)
        self.assertEqual(model['services']['db']['environment']['POSTGRES_PASSWORD'].replace('$$', '$'), self.env['DATABASE_PASSWORD'])
        self.assertEqual(model['services']['erp']['environment']['ADMIN_PASSWORD'].replace('$$', '$'), self.env['ADMIN_PASSWORD'])
        self.assertIn('$POSTGRES_USER', model['services']['db']['healthcheck']['test'][1])
        self.assertNotIn('env_file', model['services']['erp'])

    def test_candidate_guards_reject_volume_network_and_mount_changes(self):
        mutations = [
            lambda m: m['volumes']['db_data'].update(external=False),
            lambda m: m['volumes']['db_data'].update(name='erp_db_data'),
            lambda m: m['networks']['app-network'].update(external=False),
            lambda m: m['services']['db']['volumes'][0].update(source='caddy_data'),
            lambda m: m['services']['db']['volumes'].append({'type': 'volume', 'target': '/other'}),
            lambda m: m['services']['erp']['volumes'][0]['bind'].update(create_host_path=True),
            lambda m: m['services']['erp']['volumes'][0].update(read_only=False),
            lambda m: m['services']['frontend']['volumes'][0].update(source='/different/assets'),
            lambda m: m['services']['db']['environment'].update(PGDATA='/different'),
            lambda m: m['services']['caddy']['networks']['app-network'].update(ipv4_address='172.18.0.6'),
            lambda m: m['services']['erp'].update(build='.'),
            lambda m: m['services']['erp'].update(image='koshsky/erp-backend:latest'),
            lambda m: m['services']['erp'].update(image='koshsky/erp-frontend@sha256:' + 'a' * 64),
            lambda m: m['services'].pop('loki'),
        ]
        for mutation in mutations:
            model = copy.deepcopy(self.model)
            mutation(model)
            with self.subTest(mutation=mutation), self.assertRaises(deploy.DeployError):
                deploy.validate_model(model)


class ClientTest(unittest.TestCase):
    def test_lost_start_ack_and_temporary_ssh_failure_resume_the_same_request(self):
        env = dict(DEPLOY_HOST='erp.koshsky.ru', DEPLOY_USER='root', DEPLOY_SSH_KEY='test-key',
                   DEPLOY_KNOWN_HOSTS='test-host-key', DEPLOY_APP_ENV_JSON=json.dumps(ENV),
                   GITHUB_SHA='a' * 40, BACKEND_VERSION='v1.4.3', FRONTEND_VERSION='v1.6.3')
        calls = []
        def command(args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) <= 2:
                raise deploy.DeployError('SSH connection lost')
            return deploy.encoded({'phase': 'succeeded', 'images': {'BACKEND_IMAGE': 'pinned'}})
        with patch.dict(os.environ, env, clear=True), patch.object(deploy, 'command', side_effect=command), \
                patch.object(deploy.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()) as output:
            deploy.deploy()
        payload = json.loads(calls[0][1]['stdin'])
        payload.pop('driver')
        identifier = deploy.digest(deploy.encoded(payload))
        self.assertIn(identifier, calls[1][0][-1])
        self.assertIn(identifier, calls[2][0][-1])
        self.assertIn('succeeded', output.getvalue())
        self.assertNotIn('test-key', output.getvalue())
        key_file = Path(calls[0][0][calls[0][0].index('-i') + 1])
        self.assertFalse(key_file.exists())

    def test_receive_of_inflight_request_attaches_without_starting_a_second_worker(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(deploy, 'ROOT', Path(tmp).resolve()), \
                patch.object(deploy.subprocess, 'Popen', return_value=Mock(pid=999999)) as popen, \
                contextlib.redirect_stdout(io.StringIO()):
            payload = {'script': base64.b64encode(b'worker-source').decode()}
            deploy.receive(payload)
            request = deploy.ROOT / '.clockwork/requests' / deploy.digest(deploy.encoded(payload))
            status = request / 'status.json'
            status.write_text('{"phase":"apply"}')
            original = Path.read_bytes
            def read_bytes(path):
                if str(path) == '/proc/999999/cmdline':
                    return b'\0'.join([b'python3', str(request / 'deploy.py').encode(), b'apply', str(request).encode()])
                return original(path)
            with patch.object(deploy.os, 'kill'), patch.object(Path, 'read_bytes', read_bytes):
                deploy.receive(payload)
            self.assertEqual(popen.call_count, 1)
            self.assertEqual(json.loads(status.read_text())['phase'], 'apply')


class ImagePlanTest(unittest.TestCase):
    def test_partial_resolution_survives_failure_and_does_not_follow_moved_first_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = Path(tmp).resolve() / 'images.json'
            first = 'koshsky/erp-backend@sha256:' + 'a' * 64
            second = 'koshsky/erp-frontend@sha256:' + 'b' * 64
            payload = {'backend': 'v1.5.0', 'frontend': 'v2.0.0'}
            with patch.object(deploy, 'pinned_image', side_effect=[first, deploy.DeployError('second pull failed')]):
                with self.assertRaises(deploy.DeployError):
                    deploy.resolve_images(plan, payload)
            self.assertEqual(json.loads(plan.read_text()), {'BACKEND_IMAGE': first})
            with patch.object(deploy, 'pinned_image', return_value=second) as resolve:
                images = deploy.resolve_images(plan, payload)
            resolve.assert_called_once_with('koshsky/erp-frontend', 'v2.0.0')
            self.assertEqual(images, {'BACKEND_IMAGE': first, 'FRONTEND_IMAGE': second})


class BackupSafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.addCleanup(patch.stopall)
        patch.object(deploy, 'ROOT', self.root).start()
        self.containers = containers(ENV)
        self.volumes = {}
        for target in ('data', 'config'):
            path = self.root / ('caddy-' + target)
            path.mkdir()
            (path / 'state').write_bytes(b'persisted-' + target.encode())
            self.volumes['erp-infra_caddy_' + target] = path
        (self.root / 'assets/custom').mkdir(parents=True)
        (self.root / 'assets/custom/icon').write_bytes(b'x' * 1024)
        self.space = patch.object(deploy.shutil, 'disk_usage', return_value=Mock(free=10 * 1024 ** 3)).start()

    def test_budget_includes_assets_and_both_certificate_volumes(self):
        before = deploy.backup_budget(self.containers, self.volumes, 1000)
        (self.root / 'assets/custom/large').write_bytes(b'x' * 8192)
        for path in self.volumes.values():
            (path / 'new').write_bytes(b'x' * 4096)
        after = deploy.backup_budget(self.containers, self.volumes, 1000)
        self.assertGreaterEqual(after - before, 2 * (8192 + 2 * 4096))
        self.assertGreater(before, deploy.SPACE_RESERVE + 2000)

    def test_ancillary_writer_aborts_before_consuming_the_running_services_reserve(self):
        sink = io.BytesIO()
        self.space.return_value = Mock(free=deploy.SPACE_RESERVE + 5)
        writer = deploy.BackupWriter(sink)
        with self.assertRaises(deploy.DeployError):
            writer.write(b'too-large')
        self.assertEqual(sink.getvalue(), b'')

    def test_backup_cannot_be_marked_complete_after_reserve_is_exhausted(self):
        self.space.return_value = Mock(free=deploy.SPACE_RESERVE - 1)
        with patch.object(deploy, 'compose'), self.assertRaises(deploy.DeployError):
            deploy.backup(self.root / 'compose.yml', self.root / 'failed-backup', self.containers, self.volumes)
        self.assertFalse((self.root / 'failed-backup/complete').exists())

    def test_stopped_caddy_can_be_backed_up_without_exec_or_restart(self):
        import tarfile
        self.containers['caddy']['State']['Running'] = False
        def compose(path, *args, **kwargs):
            if 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' in args:
                kwargs['stdout'].write(b'PGDMP-test')
            return b''
        with patch.object(deploy, 'compose', side_effect=compose), patch.object(deploy, 'command') as command:
            destination = self.root / 'backup'
            deploy.backup(self.root / 'compose.yml', destination, self.containers, self.volumes)
        command.assert_not_called()
        for target in ('data', 'config'):
            with tarfile.open(destination / ('caddy-' + target + '.tar.gz')) as archive:
                self.assertEqual(archive.extractfile('./state').read(), b'persisted-' + target.encode())
        self.assertTrue((destination / 'complete').is_file())


class LokiReadinessTest(unittest.TestCase):
    def test_probe_retries_http_unavailability_before_accepting_readiness(self):
        with patch.object(deploy, 'command', side_effect=[deploy.DeployError('HTTP 503'), b'ready']) as command, \
                patch.object(deploy.time, 'sleep') as sleep:
            deploy.wait_loki('caddy@sha256:' + 'a' * 64)
        self.assertEqual(command.call_count, 2)
        self.assertIn('http://loki:3100/ready', command.call_args.args[0])
        self.assertIn('--fail', command.call_args.args[0])
        sleep.assert_called_once_with(2)

    def test_probe_timeout_fails_instead_of_proceeding_to_application_start(self):
        with patch.object(deploy, 'command', side_effect=deploy.DeployError('HTTP 503')), \
                patch.object(deploy.time, 'monotonic', side_effect=[0, 181]):
            with self.assertRaisesRegex(deploy.DeployError, 'Loki readiness failed'):
                deploy.wait_loki('caddy@sha256:' + 'a' * 64)
