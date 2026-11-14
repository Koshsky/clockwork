import copy
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "ci.py"
SPEC = importlib.util.spec_from_file_location("ci", SCRIPT)
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class PathsTest(unittest.TestCase):
    def test_application_inputs(self):
        cases = {
            "backend/internal/task/service.go": (True, False, False),
            "backend/go.sum": (True, False, False),
            "backend/Dockerfile": (True, False, False),
            "backend/.dockerignore": (True, False, False),
            "backend/.golangci.yml": (True, False, False),
            "backend/VERSION": (True, False, False),
            "backend/migrations/V15__next.sql": (True, False, False),
            "backend/docs/swagger/swagger.yaml": (True, False, True),
            "backend/docs/swagger/swagger.json": (True, False, True),
            "backend/docs/swagger/docs.go": (True, False, True),
            "frontend/src/views/PlannerPage.vue": (False, True, False),
            "frontend/package.json": (False, True, False),
            "frontend/package-lock.json": (False, True, False),
            "frontend/Dockerfile": (False, True, False),
            "frontend/.storybook/main.ts": (False, True, False),
            "frontend/desktop/main.js": (False, True, False),
            "frontend/src/assets/default/hints/ru/planner.md": (False, True, False),
            "frontend/public/robots.txt": (False, True, False),
            "frontend/src/api/api.ts": (False, True, True),
            "frontend/openapitools.json": (False, True, True),
            "scripts/generate-api.sh": (False, False, True),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(tuple(ci.classify([path]).values()), expected)

    def test_documentation_and_tooling_do_not_select_applications(self):
        for path in (
            "README.md", "AGENTS.md", "CONTRIBUTING.md", "docs/development.md", "docs/media/planning.png",
            ".github/workflows/ci.yml", ".github/workflows/release.yml", "scripts/ci.py", "scripts/release.py",
            ".github/workflows/ci-backend.yml", ".github/workflows/ci-frontend.yml", ".github/workflows/ci-common.yml",
            "scripts/tests/test_ci.py", "compose.yaml", "deploy/Caddyfile", "Makefile", ".gitignore", ".env.example",
            "backend/AGENTS.md", "backend/README.md", "backend/docs/development.md", "backend/migrations/README.md",
            "backend/Changelog_RU.md", "frontend/Changelog_ENG.md", "frontend/README.md", "frontend/AGENTS.md",
            "frontend/desktop/README.md", "frontend/docs/manual.rst", "backendish/file.go",
        ):
            with self.subTest(path=path):
                self.assertEqual(ci.classify([path]), dict.fromkeys(ci.FLAGS, False))

    def test_mixed_changes_keep_application_selection(self):
        self.assertEqual(ci.classify(["README.md", ".github/workflows/ci.yml", "frontend/src/view.vue"]),
                         {"backend": False, "frontend": True, "api": False})

    def test_empty_change_set(self):
        self.assertEqual(ci.classify([]), dict.fromkeys(ci.FLAGS, False))

    def test_line_separators_fail_closed(self):
        for character in "\r\n\u2028\u2029":
            with self.subTest(character=repr(character)), self.assertRaises(ValueError):
                ci.classify(["backend/a" + character + "file.go"])


class GateTest(unittest.TestCase):
    @staticmethod
    def needs(flags):
        needs = {"common": {"result": "success", "outputs": {
            "policy_result": "success", "api_result": "success" if flags[2] else "skipped",
        }}}
        for flag, selected in zip(ci.FLAGS, flags):
            needs[ci.DETECTORS[flag]] = {"result": "success", "outputs": {flag: str(selected).lower()}}
            if flag in ci.SERVICE_RESULTS:
                needs[flag] = {"result": "success" if selected else "skipped", "outputs": {
                    result: "success" for result in ci.SERVICE_RESULTS[flag]
                } if selected else {}}
        return needs

    def test_all_selections_and_deliberate_skips(self):
        for flags in itertools.product((True, False), repeat=3):
            with self.subTest(flags=flags):
                ci.verify(self.needs(flags))

    def test_failed_cancelled_missing_or_unexpectedly_skipped_job(self):
        for flags in itertools.product((True, False), repeat=3):
            expected = self.needs(flags)
            for job in expected:
                for result in ("success", "failure", "cancelled", "skipped", ""):
                    if result == expected[job]["result"]:
                        continue
                    with self.subTest(flags=flags, job=job, result=result):
                        changed = copy.deepcopy(expected)
                        changed[job]["result"] = result
                        with self.assertRaises(ValueError):
                            ci.verify(changed)
                with self.subTest(flags=flags, missing=job):
                    changed = copy.deepcopy(expected)
                    del changed[job]
                    with self.assertRaises(ValueError):
                        ci.verify(changed)

    def test_invalid_or_missing_change_output(self):
        for flag in ci.FLAGS:
            for value in (None, "", "TRUE", "unknown", True):
                with self.subTest(flag=flag, value=value):
                    changed = self.needs((False, False, False))
                    changed[ci.DETECTORS[flag]]["outputs"][flag] = value
                    with self.assertRaises(ValueError):
                        ci.verify(changed)

    def test_nested_job_failure_cancellation_or_unexpected_skip_blocks_successful_group(self):
        for flags in itertools.product((True, False), repeat=3):
            expected = self.needs(flags)
            for group in ("backend", "frontend", "common"):
                for output, current in expected[group]["outputs"].items():
                    for result in ("success", "failure", "cancelled", "skipped", "", None):
                        if result == current:
                            continue
                        with self.subTest(flags=flags, group=group, output=output, result=result):
                            changed = copy.deepcopy(expected)
                            changed[group]["outputs"][output] = result
                            with self.assertRaises(ValueError):
                                ci.verify(changed)

    def test_missing_nested_job_results_block_successful_group(self):
        for flags in itertools.product((True, False), repeat=3):
            expected = self.needs(flags)
            for group in ("backend", "frontend", "common"):
                for output in expected[group]["outputs"]:
                    with self.subTest(flags=flags, group=group, output=output):
                        changed = copy.deepcopy(expected)
                        del changed[group]["outputs"][output]
                        with self.assertRaises(ValueError):
                            ci.verify(changed)
                if expected[group]["outputs"]:
                    with self.subTest(flags=flags, group=group):
                        changed = copy.deepcopy(expected)
                        del changed[group]["outputs"]
                        with self.assertRaises(ValueError):
                            ci.verify(changed)

    def test_gate_cli_uses_reusable_workflow_results(self):
        for flags in itertools.product((True, False), repeat=3):
            env = {**os.environ, "NEEDS_JSON": json.dumps(self.needs(flags))}
            with self.subTest(flags=flags):
                result = subprocess.run(["python3", str(SCRIPT), "verify"], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
        invalid = self.needs((True, True, True))
        invalid["backend"]["outputs"]["lint_result"] = "skipped"
        result = subprocess.run(["python3", str(SCRIPT), "verify"],
                                env={**os.environ, "NEEDS_JSON": json.dumps(invalid)}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backend/lint_result", result.stderr)


class GitDetectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.write("backend/task.go")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
                                       cwd=self.root, text=True, stderr=subprocess.PIPE).strip()

    def write(self, path):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n")

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def detect_push(self, head):
        return ci.detect("push", {"before": self.base, "after": head}, self.root)

    def test_documentation_push(self):
        self.write("docs/readme.md")
        self.assertEqual(self.detect_push(self.commit()), dict.fromkeys(ci.FLAGS, False))

    def test_deleted_backend_file(self):
        (self.root / "backend/task.go").unlink()
        self.assertEqual(self.detect_push(self.commit()), {"backend": True, "frontend": False, "api": False})

    def test_cross_service_rename_selects_both(self):
        (self.root / "frontend").mkdir()
        (self.root / "backend/task.go").rename(self.root / "frontend/task.go")
        self.assertEqual(self.detect_push(self.commit()), {"backend": True, "frontend": True, "api": False})

    def test_multiple_commits_in_push(self):
        self.write("frontend/src/view.vue")
        self.commit()
        self.write("docs/readme.md")
        self.assertEqual(self.detect_push(self.commit()), {"backend": False, "frontend": True, "api": False})

    def test_pr_uses_merge_base_not_changes_on_target_branch(self):
        self.git("checkout", "-qb", "feature")
        self.write("frontend/src/view.vue")
        head = self.commit()
        self.git("checkout", "-q", "--detach", self.base)
        self.write("backend/other.go")
        base = self.commit()
        event = {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}
        self.assertEqual(ci.detect("pull_request", event, self.root), {"backend": False, "frontend": True, "api": False})

    def test_first_push_selects_all(self):
        event = {"before": "0" * 40, "after": self.base}
        self.assertEqual(ci.detect("push", event, self.root), dict.fromkeys(ci.FLAGS, True))

    def test_missing_force_push_base_selects_all(self):
        event = {"before": "a" * 40, "after": self.base}
        self.assertEqual(ci.detect("push", event, self.root), dict.fromkeys(ci.FLAGS, True))

    def test_event_and_sha_validation(self):
        with self.assertRaises(ValueError):
            ci.detect("workflow_dispatch", {}, self.root)
        for value in ("--output=/tmp/test", "main", "a\n" * 40, "abcd", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ci.detect("push", {"before": value, "after": self.base}, self.root)

    def test_detect_cli_appends_boolean_outputs(self):
        self.write("frontend/src/a file.vue")
        event = self.root / "event.json"
        head = self.commit()
        event.write_text(json.dumps({"before": self.base, "after": head}))
        output = self.root / "output"
        output.write_text("existing=value\n")
        env = {**os.environ, "GITHUB_EVENT_NAME": "push", "GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output)}
        # The CLI reads the actual repository; isolate only the diff process for this fixture.
        with patch.object(ci, "ROOT", self.root), patch.object(ci, "detect", return_value=ci.classify(["frontend/src/a file.vue"])):
            with patch.object(ci.sys, "argv", [str(SCRIPT), "detect"]), patch.dict(os.environ, env):
                ci.main()
        self.assertEqual(output.read_text(), "existing=value\nbackend=false\nfrontend=true\napi=false\n")


class WorkflowWiringTest(unittest.TestCase):
    @staticmethod
    def workflow(name):
        return (SCRIPT.parent.parent / ".github/workflows" / name).read_text()

    @classmethod
    def jobs(cls, name):
        text = cls.workflow(name).split("\njobs:\n", 1)[1]
        return dict(re.findall(r"^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)", text, re.MULTILINE | re.DOTALL))

    def test_caller_has_three_parallel_reusable_groups_with_unchanged_filters(self):
        jobs = self.jobs("ci.yml")
        self.assertEqual(set(jobs), {"backend-changes", "frontend-changes", "common-changes",
                                     "backend", "frontend", "common", "required"})
        for group in ("backend", "frontend", "common"):
            with self.subTest(group=group):
                self.assertIn(f"    needs: {group}-changes\n", jobs[group])
                self.assertIn(f"    uses: ./.github/workflows/ci-{group}.yml\n", jobs[group])
                self.assertNotIn("runs-on:", jobs[group])
                self.assertNotIn("steps:", jobs[group])
        for group in ("backend", "frontend"):
            self.assertIn(f"    if: needs.{group}-changes.outputs.{group} == 'true'\n", jobs[group])
        self.assertIn("    if: always()\n", jobs["common"])
        self.assertIn("check-api: ${{ needs.common-changes.outputs.api == 'true' }}", jobs["common"])

    def test_detectors_are_independent_roots_with_complete_history(self):
        jobs = self.jobs("ci.yml")
        self.assertEqual(set(ci.DETECTORS), set(ci.FLAGS))
        for flag, detector in ci.DETECTORS.items():
            with self.subTest(flag=flag):
                self.assertNotIn("    needs:", jobs[detector])
                self.assertNotIn("    if:", jobs[detector])
                label = "API" if flag == "api" else flag
                self.assertIn(f"    name: Is {label} changed?\n", jobs[detector])
                self.assertIn("fetch-depth: 0", jobs[detector])
                self.assertIn("python3 scripts/ci.py detect", jobs[detector])
                outputs = jobs[detector].split("    outputs:\n", 1)[1].split("    steps:\n", 1)[0]
                self.assertEqual(re.findall(r"^      ([\w-]+):", outputs, re.MULTILINE), [flag])
                self.assertIn("${{ steps.filter.outputs." + flag + " }}", outputs)

    def test_parallel_groups_have_distinct_predecessors_and_no_cross_dependencies(self):
        jobs = self.jobs("ci.yml")
        predecessors = {}
        for group in ("backend", "frontend", "common"):
            predecessors[group] = re.search(r"^    needs: (.+)$", jobs[group], re.MULTILINE).group(1)
            self.assertEqual(predecessors[group], group + "-changes")
        self.assertEqual(len(set(predecessors.values())), 3)

    def test_reusable_workflows_have_only_call_trigger_and_read_permissions(self):
        for group in ("backend", "frontend", "common"):
            with self.subTest(group=group):
                workflow = self.workflow(f"ci-{group}.yml")
                events = workflow.split("\non:\n", 1)[1].split("\npermissions:\n", 1)[0]
                self.assertEqual(re.findall(r"^  ([a-z_]+):", events, re.MULTILINE), ["workflow_call"])
                self.assertIn("permissions:\n  contents: read\n", workflow)
                self.assertNotIn("concurrency:", workflow)

    def test_reusable_workflows_preserve_checks_and_expose_all_job_results(self):
        expected = {
            "backend": {"backend": ("build_result", ("go build ./...", "go vet ./...", "go test ./...")),
                        "backend-lint": ("lint_result", ("golangci-lint@v2.15.0 run ./...",))},
            "frontend": {"frontend": ("checks_result", ("npm ci", "npm run check", "npm run lint",
                         "npm run test:stories -- --project unit", "node --test tests/security.test.cjs", "npm run build")),
                         "native-gate": ("native_result", ('test "$NATIVE_RESULT" = success',))},
            "common": {"policy": ("policy_result", ("python3 scripts/check-repository.py",
                       "python3 -m unittest discover -s scripts/tests -v", "rhysd/actionlint:", "Verify topic branch")),
                       "api-client": ("api_result", ("scripts/generate-api.sh --check",))},
        }
        for group, expected_jobs in expected.items():
            workflow = self.workflow(f"ci-{group}.yml")
            jobs = self.jobs(f"ci-{group}.yml")
            self.assertEqual(set(jobs), set(expected_jobs) | ({"native-storage"} if group == "frontend" else set()))
            for job, (output, commands) in expected_jobs.items():
                with self.subTest(group=group, job=job):
                    self.assertIn(f"      {output}:\n", workflow)
                    value = "jobs." + job + ".outputs.result"
                    if job == "api-client":
                        value += " || 'skipped'"
                    self.assertIn("value: ${{ " + value + " }}", workflow)
                    self.assertIn("    outputs:\n      result: ${{ job.status }}\n", jobs[job])
                    for command in commands:
                        self.assertIn(command, jobs[job])
                    if job == "native-gate":
                        self.assertIn("    needs: native-storage\n", jobs[job])
                        self.assertIn("    if: always()\n", jobs[job])
                    else:
                        self.assertNotIn("    needs:", jobs[job])
                    if job == "api-client":
                        self.assertIn("    if: inputs.check-api\n", jobs[job])
                    elif job != "native-gate":
                        self.assertNotRegex(jobs[job], r"(?m)^    if:")

    def test_final_gate_waits_for_all_three_groups_even_when_skipped_or_failed(self):
        gate = self.jobs("ci.yml")["required"]
        self.assertIn("    needs: [backend-changes, frontend-changes, common-changes, backend, frontend, common]\n", gate)
        self.assertIn("    if: always()\n", gate)

    def test_final_gate_checks_out_its_script(self):
        workflow = (SCRIPT.parent.parent / ".github/workflows/ci.yml").read_text()
        gate = workflow.split("  required:\n", 1)[1]
        self.assertLess(gate.index("uses: actions/checkout@"), gate.index("python3 scripts/ci.py verify"))
        self.assertIn("if: always()", gate)
        self.assertIn("NEEDS_JSON: ${{ toJSON(needs) }}", gate)

    def test_release_has_only_manual_trigger_and_ordered_phases(self):
        workflow = (SCRIPT.parent.parent / ".github/workflows/release.yml").read_text()
        events = workflow.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertEqual(re.findall(r"^  ([a-z_]+):", events, re.MULTILINE), ["workflow_dispatch"])
        self.assertEqual(re.findall(r"run: python3 scripts/release.py (\w+)", workflow), ["plan", "build", "publish", "promote"])
        self.assertIn("cancel-in-progress: false", workflow)


class DesktopStorageWiringTest(unittest.TestCase):
    def test_native_storage_matrix_is_required_and_covers_all_target_systems(self):
        native = WorkflowWiringTest.jobs("ci-frontend.yml")["native-storage"]
        self.assertIn("os: [ubuntu-latest, windows-latest, macos-latest]", native)
        self.assertIn("fail-fast: false", native)
        self.assertIn("node-version: 24", native)
        self.assertIn("xvfb-run -a node frontend/scripts/test-desktop-storage.cjs", native)
        self.assertNotIn("    needs:", native)
        self.assertIn("native_result", ci.SERVICE_RESULTS["frontend"])
