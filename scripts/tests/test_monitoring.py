"""Policy behavior for the optional monitoring model."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('monitoring', Path(__file__).resolve().parents[1] / 'check-monitoring.py')
monitoring = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitoring)


class MonitoringPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve(); root.chmod(0o700)
        password = root / 'password'; password.write_text('isolated-fixture-password')
        base = {'mem_limit': 256 * 1024 ** 2, 'read_only': True, 'cap_drop': ['ALL'], 'profiles': ['monitoring'],
                'network_mode': 'container:fixture', 'image': 'fixture@sha256:' + 'a' * 64}
        self.model = {'services': {'prometheus': copy.deepcopy(base), 'grafana': copy.deepcopy(base)},
                      'secrets': {'admin_password': {'file': str(password)}}}
        self.model['services']['grafana']['environment'] = {'GF_SERVER_HTTP_ADDR': '127.0.0.1',
            'GF_AUTH_ANONYMOUS_ENABLED': 'false', 'GF_ANALYTICS_REPORTING_ENABLED': 'false'}
    def test_valid_namespace_sharing_has_no_published_ports(self):
        self.assertEqual(monitoring.validate(self.model)['published_ports'], 0)
    def test_rejects_public_wildcard_hosts_privilege_socket_and_memory_growth(self):
        mutations = [lambda m: m['services']['grafana']['environment'].update(GF_SERVER_HTTP_ADDR='0.0.0.0'),
                     lambda m: m['services']['grafana']['environment'].update(GF_SERVER_HTTP_ADDR='8.8.8.8'),
                     lambda m: m['services']['grafana'].update(ports=[{'published': '3000'}]),
                     lambda m: m['services']['prometheus'].update(privileged=True),
                     lambda m: m['services']['prometheus'].update(mem_limit=2 * 1024 ** 3),
                     lambda m: m['services']['prometheus'].update(volumes=[{'source': '/var/run/docker.sock', 'target': '/socket'}]),
                     lambda m: m['services']['grafana'].update(network_mode='host')]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index), self.assertRaises(ValueError):
                model = copy.deepcopy(self.model); mutate(model); monitoring.validate(model)
    def test_password_requires_a_private_directory_and_is_never_in_report(self):
        result = monitoring.validate(self.model)
        self.assertNotIn('isolated-fixture-password', str(result))
        Path(self.tmp.name).chmod(0o755)
        with self.assertRaises(ValueError): monitoring.validate(self.model)
