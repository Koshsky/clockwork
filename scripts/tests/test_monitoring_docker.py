"""Opt-in real optional-stack acceptance; only UUID containers/volumes are touched."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('monitoring_model', ROOT / 'scripts/check-monitoring.py')
monitoring = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(monitoring)


@unittest.skipUnless(os.environ.get('CLOCKWORK_MONITORING_DOCKER_TESTS') == '1', 'explicit isolated monitoring fixtures')
class MonitoringDockerTest(unittest.TestCase):
    def test_pinned_example_scrapes_authenticates_restarts_and_respects_resource_budget(self):
        project = 'cw-monitor-' + uuid.uuid4().hex
        def docker(*args, check=True, timeout=60):
            return subprocess.run(['docker', *args], capture_output=True, text=True, check=check, timeout=timeout)
        with tempfile.TemporaryDirectory(prefix=project, dir=os.environ.get('CLOCKWORK_MONITORING_TEST_DIR')) as folder:
            root = Path(folder).resolve(); root.chmod(0o700)
            password = root / 'password'; password.write_text('isolated-monitor-fixture-password'); password.chmod(0o444)
            config = root / 'prometheus.yml'
            config.write_text((ROOT / 'deploy/observability/prometheus.yml').read_text().replace('30s', '1s').replace('3s', '500ms'))
            # Faster fixture cadence only; repository cadence remains 30s.
            env = dict(os.environ, CLOCKWORK_BACKEND_CONTAINER=project, CLOCKWORK_GRAFANA_BIND='127.0.0.1', CLOCKWORK_GRAFANA_PASSWORD_FILE=str(password))
            override = root / 'override.json'
            override.write_text(json.dumps({'services': {'prometheus': {'volumes': [str(config) + ':/etc/prometheus/prometheus.yml:ro']}}}))
            def compose(*args, check=True, profile=True):
                result = subprocess.run(['docker', 'compose', '-p', project, '-f', str(ROOT / 'deploy/observability/compose.yml'),
                                       '-f', str(override), *(['--profile', 'monitoring'] if profile else []), *args], env=env, capture_output=True,
                                      text=True, check=False, timeout=120)
                if check and result.returncode:
                    raise RuntimeError('Isolated compose failed: ' + result.stderr)
                return result
            def request(url, auth=False):
                code = "fetch(process.argv[1],{headers:" + ("{Authorization:'Basic '+Buffer.from('owner:isolated-monitor-fixture-password').toString('base64')}" if auth else '{}') + "}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()})))"
                return json.loads(docker('exec', project, 'node', '-e', code, url).stdout)
            def query(expr):
                from urllib.parse import quote
                result = request('http://127.0.0.1:9090/api/v1/query?query=' + quote(expr))
                return json.loads(result['body'])['data']['result']
            try:
                fixture = "let n=0;require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/plain; version=0.0.4');s.end('clockwork_http_requests_total{route=\"/api/v1/project\",method=\"GET\",status=\"200\",outcome=\"success\"} '+(++n)+'\\ngo_memstats_alloc_bytes 8388608\\nclockwork_db_pool_total_connections 2\\nclockwork_build_info{version=\"1.6.0\"} 1\\n')}).listen(9091,'127.0.0.1');setInterval(()=>{},10000)"
                docker('run', '-d', '--pull', 'never', '--name', project, '--network', 'none', '--read-only',
                       'node:22-alpine', 'node', '-e', fixture)
                model = json.loads(compose('config', '--format', 'json').stdout)
                self.assertEqual(monitoring.validate(model)['memory_limit_bytes'], 896 * 1024 ** 2)
                no_profile = compose('up', '-d', '--no-build', '--pull', 'never', profile=False, check=False)
                self.assertNotEqual(no_profile.returncode, 0)
                self.assertIn('no service selected', no_profile.stderr.lower())
                compose('up', '-d', '--no-build', '--pull', 'never')
                for _ in range(100):
                    result = docker('exec', project, 'node', '-e', "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))", check=False)
                    if result.returncode == 0:
                        break
                    name = compose('ps', '-a', '-q', 'grafana').stdout.strip()
                    if docker('inspect', '--format', '{{.State.Status}}', name).stdout.strip() == 'exited':
                        logs = docker('logs', '--tail', '50', name, check=False)
                        self.fail('Grafana fixture exited: ' + (logs.stdout + logs.stderr)[-1000:])
                    time.sleep(.5)
                else:
                    self.fail('Grafana fixture was not ready')
                self.assertEqual(request('http://127.0.0.1:3001/api/search')['status'], 401)
                self.assertEqual(request('http://127.0.0.1:3001/api/search', True)['status'], 200)
                for _ in range(40):
                    samples = query('up{job="clockwork"}')
                    if samples and samples[0]['value'][1] == '1': break
                    time.sleep(.25)
                else: self.fail('Fixture metrics were not scraped')
                self.assertTrue(query('clockwork_http_requests_total'))
                for filename in sorted((ROOT / 'deploy/observability/grafana/dashboards').glob('*.json')):
                    dashboard = json.loads(filename.read_text())
                    loaded = request('http://127.0.0.1:3001/api/dashboards/uid/' + dashboard['uid'], True)
                    self.assertEqual(loaded['status'], 200)
                    for panel in dashboard['panels']:
                        query(panel['targets'][0]['expr'])
                self.assertEqual(query('absent(nonexistent_clockwork_metric)')[0]['value'][1], '1')
                names = [compose('ps', '-q', service).stdout.strip() for service in ('prometheus', 'grafana')]
                stats = [json.loads(line) for line in docker('stats', '--no-stream', '--format', '{{json .}}', *names).stdout.splitlines()]
                def bytes_value(value):
                    match = re.match(r'([\d.]+)([KMG]?i?B)', value)
                    return float(match[1]) * {'B':1,'kB':1000,'KB':1000,'KiB':1024,'MB':1000**2,'MiB':1024**2,'GB':1000**3,'GiB':1024**3}[match[2]]
                memory = sum(bytes_value(row['MemUsage'].split(' / ')[0]) for row in stats)
                disk = 0
                for name, path in zip(names, ('/prometheus', '/var/lib/grafana')):
                    docker('exec', name, 'sh', '-c', 'printf fixture > ' + path + '/restart-marker')
                    disk += int(docker('exec', name, 'du', '-sk', path).stdout.split()[0]) * 1024
                    ports = docker('inspect', '--format', '{{json .HostConfig.PortBindings}}', name).stdout.strip()
                    self.assertIn(ports, ('{}', 'null'))
                self.assertLess(memory, 1024 ** 3)
                self.assertLess(disk + 40 * 1024 ** 2, 2 * 1024 ** 3)
                compose('restart')
                for name, path in zip(names, ('/prometheus', '/var/lib/grafana')):
                    for _ in range(50):
                        ready = docker('exec', name, 'cat', path + '/restart-marker', check=False)
                        if ready.returncode == 0: break
                        time.sleep(.1)
                    self.assertEqual(ready.stdout, 'fixture')
                # A real full tiny filesystem fails only the optional TSDB, never the backend fixture.
                image = model['services']['prometheus']['image']
                docker('run', '-d', '--name', project + '-full', '--memory', '128m', '--cpus', '.25',
                       '--pull', 'never', '--network', 'container:' + project, '--read-only',
                       '-e', 'GOMAXPROCS=1', '-e', 'GOMEMLIMIT=96MiB',
                       '--mount', 'type=bind,source=' + str(config) + ',target=/etc/prometheus/full.yml,readonly',
                       '--tmpfs', '/prometheus:size=64k,uid=65534,gid=65534,mode=0700', image,
                       '--web.listen-address=127.0.0.1:9093', '--config.file=/etc/prometheus/full.yml',
                       '--storage.tsdb.path=/prometheus', '--storage.tsdb.wal-segment-size=16MB')
                for _ in range(40):
                    ready = docker('exec', project, 'node', '-e', "fetch('http://127.0.0.1:9093/-/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))", check=False)
                    if ready.returncode == 0: break
                    time.sleep(.1)
                else: self.fail('Quota fixture did not start')
                full = docker('exec', project + '-full', 'sh', '-c',
                              'dd if=/dev/zero of=/prometheus/space-pressure bs=4096 count=100', check=False)
                self.assertNotEqual(full.returncode, 0)
                self.assertIn('No space left', full.stdout + full.stderr)
                self.assertEqual(docker('inspect', '--format', '{{.State.Running}}', project).stdout.strip(), 'true')
                print(json.dumps({'optional_stack_memory_bytes': int(memory), 'state_disk_bytes': disk,
                                  'fixture_cpu_percent': [row['CPUPerc'] for row in stats], 'cadence_seconds': 1,
                                  'restart_preserved': True, 'private_ports': True, 'quota_failure_isolated': True}))
            finally:
                docker('rm', '-f', '-v', project + '-full', check=False)
                compose('down', '--volumes', check=False)
                docker('rm', '-f', '-v', project, check=False)
