"""External observation contracts, including real isolated outage/recovery."""
import importlib.util
import json
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('probe', Path(__file__).resolve().parents[1] / 'probe-demo.py')
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class ProbeTest(unittest.TestCase):
    def test_rejects_credentials_queries_paths_and_insecure_remote_targets(self):
        for value in ['file:///etc/passwd', 'http://example.com', 'https://u:secret@site',
                      'https://site?secret=1', 'https://site/path', 'https://site/#secret', 'https://site\n']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe.validate_url(value)

    def test_disabled_example_never_contacts_a_server(self):
        with patch.object(probe, 'bounded_probe') as run, patch('builtins.print') as output:
            result = probe.main(['--config', str(Path(__file__).resolve().parents[2] / 'deploy/observability/probe.example.json')])
        self.assertEqual(result, 2)
        run.assert_not_called()
        self.assertEqual(json.loads(output.call_args.args[0]), {'status': 'not_configured'})

    def test_dns_and_entire_probe_have_a_hard_parent_deadline(self):
        with patch.object(probe.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private', 6)) as run:
            result = probe.bounded_probe('https://fixture.invalid')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(run.call_args.kwargs['timeout'], 6)
        self.assertNotIn('private', json.dumps(result))

    def test_live_static_is_not_readiness_and_failed_recovered_states_are_distinct(self):
        fixture = {'status': 200, 'body': b'<html>static is up</html>'}
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(fixture['status'])
                self.end_headers()
                self.wfile.write(fixture['body'])
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{server.server_port}'
        try:
            self.assertEqual(probe.bounded_probe(url)['status'], 'failed')
            fixture.update(status=503, body=b'{"data":{"status":"not_ready"},"error":{}}')
            result = probe.bounded_probe(url)
            self.assertEqual((result['status'], result['reachable']), ('failed', True))
            fixture.update(status=200, body=b'{"data":{"status":"ready"},"error":{}}')
            self.assertEqual(probe.bounded_probe(url)['status'], 'ok')
            fixture['body'] = b'secret' * 10000
            self.assertEqual(probe.bounded_probe(url)['status'], 'failed')
        finally:
            server.shutdown(); server.server_close(); worker.join()
        self.assertEqual(probe.bounded_probe(url)['status'], 'failed')
