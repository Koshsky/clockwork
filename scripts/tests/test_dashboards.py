"""Dashboard contracts and real PromQL semantics without production data."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DASH = ROOT / 'deploy/observability/grafana/dashboards'


class DashboardTest(unittest.TestCase):
    def test_two_focused_dashboards_with_private_datasource_and_explicit_no_data(self):
        files = sorted(DASH.glob('*.json'))
        self.assertEqual(len(files), 2)
        for path in files:
            value = json.loads(path.read_text())
            self.assertEqual(len(value['panels']), 8)
            self.assertFalse(value['editable'])
            self.assertEqual(value['templating']['list'], [])
            self.assertIn('data', value['description'])
            for panel in value['panels']:
                self.assertEqual(panel['datasource']['uid'], 'clockwork-prometheus')
                self.assertEqual(panel['fieldConfig']['defaults']['noValue'], 'No data')
                self.assertNotIn('or vector(0)', panel['targets'][0]['expr'])
        self.assertNotIn('user_id', ''.join(p.read_text() for p in files))
        self.assertNotIn('loki', ''.join(p.read_text() for p in files).lower())

    @unittest.skipUnless(os.environ.get('CLOCKWORK_MONITORING_DOCKER_TESTS') == '1', 'real pinned PromQL evaluator')
    def test_promql_no_data_denials_errors_and_counter_resets(self):
        dashboard = json.loads((DASH / 'http.json').read_text())
        ratio = dashboard['panels'][3]['targets'][0]['expr']
        throughput = dashboard['panels'][2]['targets'][0]['expr']
        metric = 'clockwork_http_requests_total{job="clockwork",route="/api/v1/task/:id",method="GET",status="%s",outcome="%s"}'
        up = {'series': 'up{job="clockwork"}', 'values': '1+0x10'}
        def case(name, series, expr, value=None):
            return {'name': name, 'interval': '1m', 'input_series': series,
                    'promql_expr_test': [{'expr': expr, 'eval_time': '5m',
                        'exp_samples': [] if value is None else [{'labels': '{}', 'value': value}]}]}
        cases = [case('no target is no data', [], ratio),
                 case('zero denominator is no data', [up, {'series': metric % ('200', 'success'), 'values': '0+0x10'}], ratio),
                 case('409 is not an infrastructure error', [up, {'series': metric % ('409', 'conflict'), 'values': '0+10x10'}], ratio, 0),
                 case('server failures are included', [up, {'series': metric % ('200', 'success'), 'values': '0+80x10'},
                      {'series': metric % ('503', 'server_error'), 'values': '0+20x10'}], '(' + ratio + ') > bool 0.1', 1),
                 case('restart counter reset remains a positive rate', [up, {'series': metric % ('200', 'success'), 'values': '0 10 20 0 10 20 30'}], '(' + throughput + ') > bool 0', 1),
                 case('down scrape does not display old healthy ratio', [{'series': 'up{job="clockwork"}', 'values': '0+0x10'},
                      {'series': metric % ('200', 'success'), 'values': '0+10x10'}], ratio)]
        with tempfile.TemporaryDirectory(dir=os.environ.get('CLOCKWORK_MONITORING_TEST_DIR')) as folder:
            fixture = Path(folder).resolve() / 'queries.json'
            fixture.write_text(json.dumps({'rule_files': [], 'evaluation_interval': '1m', 'tests': cases}))
            result = subprocess.run(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
                '--tmpfs', '/tmp:size=32m,nosuid,noexec', '--mount', 'type=bind,source=' + str(fixture) + ',target=/checks.json,readonly',
                '--entrypoint', '/bin/promtool', 'prom/prometheus:v3.16.0', 'test', 'rules', '/checks.json'],
                capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
