"""Deterministic demo alert transitions; never sends real messages."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
import os
import json
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location('alerts', Path(__file__).resolve().parents[1] / 'demo-alerts.py')
alerts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(alerts)


class AlertTest(unittest.TestCase):
    def setUp(self):
        self.policy = {'enabled': True, 'debounce_samples': 2, 'stale_after_seconds': 120,
                       'tls_min_seconds': 3600, 'disks': ['database']}
        self.host = {'checked_at': 1000, 'services': {'db': {'status': 'ok'}},
                     'disks': {'database': {'status': 'ok', 'inodes': {'status': 'ok'}}}}
        self.external = {'checked_at': 1000, 'status': 'ok', 'tls': {'status': 'observed', 'remaining_seconds': 7200}}
        self.sink = Mock(return_value=True)
    def cycle(self, state=None, sink=True, now=1000):
        return alerts.run_cycle(self.policy, self.host, self.external, state, now, self.sink if sink else None)

    def test_firing_dedup_and_recovery_need_consecutive_samples(self):
        self.host['services']['db']['status'] = 'failed'
        state, result = self.cycle(); self.assertEqual(result['events'], [])
        state, result = self.cycle(state); self.assertEqual(result['events'][0]['state'], 'firing')
        state, result = self.cycle(state); self.assertEqual(result['events'], [])
        self.host['services']['db']['status'] = 'ok'
        state, result = self.cycle(state); self.assertEqual(result['events'], [])
        state, result = self.cycle(state); self.assertEqual(result['events'][0]['state'], 'resolved')
        self.assertEqual(self.sink.call_count, 2)

    def test_missing_and_stale_samples_are_not_healthy(self):
        for external in [{}, self.external]:
            self.external = external
            state, _ = self.cycle(now=2000)
            state, result = self.cycle(state, now=2000)
            self.assertTrue(result['events'])
            self.assertTrue(all(e['state'] == 'no_data' for e in result['events']))

    def test_channel_failure_retries_the_same_event_without_claiming_delivery(self):
        self.external['status'] = 'failed'
        self.sink.side_effect = RuntimeError('private credentials')
        state, _ = self.cycle()
        state, first = self.cycle(state)
        state, second = self.cycle(state)
        self.assertEqual(first['events'][0]['delivery'], 'pending')
        self.assertEqual(first['events'][0]['id'], second['events'][0]['id'])
        self.sink.side_effect = None
        state, result = self.cycle(state)
        self.assertEqual(result['events'][0]['delivery'], 'accepted')
        state, result = self.cycle(state)
        self.assertEqual(result['events'], [])

    def test_not_configured_delivery_and_no_resolved_for_an_undelivered_alarm(self):
        self.external['status'] = 'failed'
        state, _ = self.cycle(sink=False)
        state, result = self.cycle(state, sink=False)
        self.assertEqual(result['events'][0]['delivery'], 'pending')
        self.external['status'] = 'ok'
        state, _ = self.cycle(state, sink=False)
        state, result = self.cycle(state, sink=False)
        self.assertEqual(result['events'], [])
        self.sink.assert_not_called()

    def test_tls_and_filesystem_policy_but_not_ordinary_client_denials(self):
        self.host['disks']['database']['inodes']['status'] = 'failed'
        self.external['tls']['remaining_seconds'] = 100
        state, _ = self.cycle()
        state, result = self.cycle(state)
        self.assertEqual({e['signal'] for e in result['events']}, {'disk', 'tls'})
        self.assertNotIn('private', str(result))

    def test_external_failure_suppresses_a_duplicate_missing_tls_alarm(self):
        self.external.update(status='failed', tls={'status': 'unknown'})
        state, _ = self.cycle()
        state, result = self.cycle(state)
        self.assertEqual([e['signal'] for e in result['events']], ['external_readiness'])

    def test_disabled_needs_no_thresholds_or_channel_and_enabled_requires_explicit_policy(self):
        self.assertEqual(alerts.run_cycle({'enabled': False}, {}, {})[1]['status'], 'not_configured')
        for key in ['debounce_samples', 'stale_after_seconds', 'tls_min_seconds']:
            policy = dict(self.policy, **{key: None})
            with self.subTest(key=key), self.assertRaises(ValueError): alerts.validate(policy)

    def test_client_offline_forbidden_and_conflict_are_not_server_incidents(self):
        self.host['clients'] = {'offline': True, 'status': 403, 'conflict': 409}
        state, _ = self.cycle()
        state, result = self.cycle(state)
        self.assertEqual(result['events'], [])

    def test_state_is_private_atomic_and_concurrent_caller_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            state = root / 'state.json'
            alerts.write_state(state, {'database': {'sample': 'bad'}})
            self.assertEqual(os.stat(state).st_mode & 0o777, 0o600)
            self.assertEqual(alerts.read_json(state)['database']['sample'], 'bad')
            fifo = root / 'fifo'; os.mkfifo(fifo)
            with self.assertRaises(ValueError): alerts.read_json(fifo)
            policy = root / 'policy.json'; policy.write_text(json.dumps(self.policy))
            lock = root / 'state.json.lock'; lock.write_text('another caller')
            from unittest.mock import patch
            with patch('builtins.print') as output:
                self.assertEqual(alerts.main(['--config', str(policy), '--state', str(state)]), 2)
            self.assertEqual(json.loads(output.call_args.args[0])['status'], 'unknown')
            self.assertTrue(lock.exists())
            self.assertEqual(alerts.read_json(state)['database']['sample'], 'bad')
