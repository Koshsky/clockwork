import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[1] / 'check-pr-versions.py'
SPEC = importlib.util.spec_from_file_location('pr_versions', SCRIPT)
pr_versions = importlib.util.module_from_spec(SPEC)
with patch.object(sys, 'path', [str(SCRIPT.parent), *sys.path]):
    SPEC.loader.exec_module(pr_versions)


class PRVersionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.write('backend/VERSION', '1.4.3\n')
        self.write('frontend/package.json', json.dumps({'version': '1.6.3', 'dependencies': {}}))
        self.base = self.commit()
        self.hub = Mock()
        self.hub.return_value.tags.return_value = ['staging', 'prod', 'v1.4.3']
        self.digest = patch.object(pr_versions.release, 'registry_digest', return_value=None).start()
        self.addCleanup(patch.stopall)

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', *args],
                                       cwd=self.root, text=True, stderr=subprocess.PIPE).strip()

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-qm', 'fixture')
        return self.git('rev-parse', 'HEAD')

    def event(self, head=None):
        return {'pull_request': {'base': {'sha': self.base}, 'head': {'sha': head or self.git('rev-parse', 'HEAD')}}}

    def check(self, head=None):
        return pr_versions.check(self.event(head), self.root, self.hub)

    def bump(self, value):
        self.write('backend/VERSION', value + '\n')
        return self.commit()

    def test_code_and_dependency_changes_without_bump_do_not_query_hub(self):
        self.write('backend/main.go', 'package main\n')
        self.write('frontend/package.json', json.dumps({'version': '1.6.3', 'dependencies': {'example': '2'}}))
        self.commit()
        self.assertEqual(self.check(), {})
        self.hub.assert_not_called()
        self.digest.assert_not_called()

    def test_mixed_code_versions_and_changelog_are_allowed(self):
        self.write('backend/main.go', 'package main\n')
        self.write('backend/Changelog_RU.md', '## [1.4.4]\n')
        self.bump('1.4.4')
        self.assertEqual(self.check(), {'backend': {'published': '1.4.3', 'candidate': '1.4.4'}})
        self.hub.assert_called_once_with('koshsky/erp-backend')
        self.digest.assert_called_once_with('koshsky/erp-backend:v1.4.4', missing=True)

    def test_patch_minor_major_single_steps(self):
        for version in ('1.4.4', '1.5.0', '2.0.0'):
            with self.subTest(version=version):
                self.bump(version)
                self.assertEqual(self.check()['backend']['candidate'], version)

    def test_invalid_skips_resets_downgrades_and_published_version(self):
        for version in ('1.4.3', '1.4.2', '1.4.5', '1.5.1', '1.6.0', '2.0.1', '3.0.0'):
            with self.subTest(version=version):
                # Ensure the PR actually changes the version, including the already-published case.
                self.base = self.bump('1.4.1')
                self.bump(version)
                with self.assertRaises(ValueError):
                    self.check()

    def test_hub_is_baseline_even_if_main_is_several_releases_behind(self):
        self.hub.return_value.tags.return_value = ['v1.4.4']
        self.bump('1.4.5')
        self.assertEqual(self.check()['backend']['published'], '1.4.4')

    def test_unpublished_main_version_does_not_set_baseline(self):
        self.base = self.bump('1.5.0')
        self.bump('1.4.4')
        self.assertEqual(self.check()['backend']['published'], '1.4.3')

    def test_target_branch_advance_does_not_count_as_pr_bump(self):
        self.git('checkout', '-qb', 'feature')
        self.write('backend/main.go', 'package main\n')
        head = self.commit()
        self.git('checkout', '-q', '--detach', self.base)
        self.base = self.bump('1.5.0')
        self.assertEqual(self.check(head), {})
        self.hub.assert_not_called()

    def test_reads_pr_head_not_checkout_merge_or_local_worktree(self):
        head = self.bump('1.4.4')
        self.write('backend/VERSION', '99.0.0\n')
        self.assertEqual(self.check(head)['backend']['candidate'], '1.4.4')

    def test_both_components_are_validated_independently(self):
        self.write('frontend/package.json', '{"version":"1.7.0"}')
        self.bump('1.4.4')
        self.hub.side_effect = lambda repo: Mock(tags=Mock(return_value=['v1.6.3' if repo.endswith('frontend') else 'v1.4.3']))
        report = self.check()
        self.assertEqual(set(report), {'frontend', 'backend'})
        self.assertEqual(report['frontend']['published'], '1.6.3')

    def test_new_canonical_file_is_checked(self):
        (self.root / 'backend/VERSION').unlink()
        self.base = self.commit()
        self.bump('1.4.4')
        self.assertEqual(self.check()['backend']['candidate'], '1.4.4')

    def test_missing_or_malformed_canonical_version_fails_closed(self):
        for value in ('v1.4.4', '01.4.4', '1.4.4-rc.1', '1.4.4+build', 'bad', ''):
            with self.subTest(value=value):
                self.bump(value)
                with self.assertRaises(ValueError):
                    self.check()
        (self.root / 'backend/VERSION').unlink()
        self.commit()
        with self.assertRaises(subprocess.CalledProcessError):
            self.check()
        self.hub.assert_not_called()

    def test_frontend_missing_version_or_broken_json_is_rejected(self):
        for content in ('{}', '{"version":null}', 'bad json'):
            with self.subTest(content=content):
                self.write('frontend/package.json', content)
                self.commit()
                with self.assertRaises((KeyError, ValueError)):
                    self.check()
        self.hub.assert_not_called()

    def test_network_failure_or_no_stable_tags_blocks_changed_version(self):
        self.bump('1.4.4')
        self.hub.return_value.tags.side_effect = OSError('registry unavailable')
        with self.assertRaises(OSError):
            self.check()
        self.hub.return_value.tags.side_effect = None
        self.hub.return_value.tags.return_value = ['staging', 'prod', 'v1.4.4-rc.1']
        with self.assertRaises(ValueError):
            self.check()

    def test_registry_failure_is_not_treated_as_unused_version(self):
        self.bump('1.4.4')
        self.digest.side_effect = OSError('registry unavailable')
        with self.assertRaises(OSError):
            self.check()

    def test_registry_detects_occupied_tag_despite_stale_hub_listing(self):
        self.bump('1.4.4')
        self.digest.return_value = 'sha256:' + 'a' * 64
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.check()

    def test_parallel_prs_do_not_reserve_versions_and_later_publication_blocks_them(self):
        self.bump('1.4.4')
        self.assertEqual(self.check(), self.check())
        self.hub.return_value.tags.return_value.append('v1.4.4')
        with self.assertRaises(ValueError):
            self.check()

    def test_invalid_sha_or_missing_history_cannot_skip_validation(self):
        for sha in ('main', '--help', None, 'a' * 40):
            event = self.event()
            event['pull_request']['base']['sha'] = sha
            with self.subTest(sha=sha), self.assertRaises((ValueError, subprocess.CalledProcessError)):
                pr_versions.check(event, self.root, self.hub)
        self.hub.assert_not_called()

    def test_cli_rejects_non_pr_events(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], env={**os.environ, 'GITHUB_EVENT_NAME': 'push'},
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('pull_request event', result.stderr)

    def test_ci_runs_read_only_pr_check_with_full_history(self):
        workflow = (SCRIPT.parent.parent / '.github/workflows/ci-common.yml').read_text()
        policy = workflow.split('  policy:\n', 1)[1].split('  api-client:\n', 1)[0]
        self.assertIn('fetch-depth: 0', policy)
        self.assertIn("if: github.event_name == 'pull_request'", policy)
        self.assertIn('run: python3 scripts/check-pr-versions.py', policy)
        self.assertNotIn('DOCKERHUB_TOKEN', policy)
        self.assertNotIn('docker push', policy)
        self.assertLess(policy.index('Verify topic branch'), policy.index('python3 scripts/check-pr-versions.py'))
