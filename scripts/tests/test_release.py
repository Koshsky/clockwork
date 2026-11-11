import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SCRIPT = Path(__file__).resolve().parents[1] / "release.py"
SPEC = importlib.util.spec_from_file_location("release", SCRIPT)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
REVISION = "a" * 40


def digest(value):
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


class FakeHub:
    def __init__(self):
        self.versions = {"koshsky/erp-frontend": ["v1.6.3"], "koshsky/erp-backend": ["v1.4.3"]}
        self.staging = {name: digest(name + " old") for name in self.versions}

    def __call__(self, repository):
        outer = self

        class Repository:
            def tags(self):
                return outer.versions[repository]

            def staging_digest(self):
                return outer.staging[repository]

        return Repository()


class FakeDocker:
    def __init__(self):
        self.commands = []
        self.local = {}
        self.remote = {}
        self.fail = None
        self.corrupt_promotion = False

    def __call__(self, args, capture=False):
        self.commands.append(args)
        if self.fail and self.fail(args):
            raise subprocess.CalledProcessError(1, args)
        if args[0] == "git":
            return REVISION
        if args[:3] == ["docker", "buildx", "build"]:
            tag = args[args.index("--tag") + 1]
            self.local[tag] = digest(tag + " built")
        elif args[:3] == ["docker", "image", "inspect"]:
            return self.local[args[3]]
        elif args[:2] == ["docker", "push"]:
            self.remote[args[2]] = digest(args[2] + " published")
        elif args[:4] == ["docker", "buildx", "imagetools", "create"]:
            target = args[args.index("--tag") + 1]
            self.remote[target] = digest("wrong") if self.corrupt_promotion else args[-1].split("@")[1]
        else:
            raise AssertionError("Unexpected Docker command: " + repr(args))
        return ""


class SemVerTest(unittest.TestCase):
    def test_only_one_step_with_resets(self):
        for previous, allowed in (
            ("1.4.1", ("1.4.2", "1.5.0", "2.0.0")),
            ("0.0.0", ("0.0.1", "0.1.0", "1.0.0")),
            ("1.9.9", ("1.9.10", "1.10.0", "2.0.0")),
        ):
            for candidate in allowed:
                with self.subTest(previous=previous, candidate=candidate):
                    release.validate_step(previous, candidate)

    def test_rejects_skips_incorrect_resets_and_downgrades(self):
        for candidate in ("1.4.1", "1.4.0", "1.3.9", "0.9.9", "1.4.3", "1.5.1", "1.6.1", "1.6.0", "2.0.1", "2.1.0", "3.0.0"):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                release.validate_step("1.4.1", candidate)

    def test_rejects_noncanonical_or_nonstable_versions(self):
        for candidate in ("v1.4.2", "1.4", "1.4.2.0", "01.4.2", "1.04.2", "1.4.02", "-1.4.2", "1.4.2-rc.1", "1.4.2+build", "1.4.2\n", " 1.4.2", "1.4.2;echo bad", "١.٤.٢", "", None, 142, "1" * 128 + ".0.0"):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                release.parse_version(candidate)

    def test_registry_baseline_is_numeric_not_creation_order(self):
        self.assertEqual(release.latest_version(["staging", "prod", "latest", "v1.9.9", "v1.10.0", "v1.10.0-rc.1", "v01.99.0", "sha-abcd", "v1.2.0"]), "1.10.0")

    def test_empty_registry_fails_closed(self):
        for tags in ([], ["staging", "latest", "v1.0.0-rc.1"]):
            with self.subTest(tags=tags), self.assertRaises(ValueError):
                release.latest_version(tags)


class HubTest(unittest.TestCase):
    def setUp(self):
        self.hub = release.Hub("koshsky/erp-backend")

    def test_paginates_to_find_older_highest_version(self):
        with patch.object(self.hub, "read", side_effect=[
            {"results": [{"name": "staging"}, {"name": "v1.4.1"}], "next": self.hub.base + "?page=2"},
            {"results": [{"name": "v1.4.3"}], "next": None},
        ]) as read:
            self.assertEqual(release.latest_version(self.hub.tags()), "1.4.3")
            self.assertEqual(read.call_count, 2)

    def test_pagination_loop_fails(self):
        with patch.object(self.hub, "read", return_value={"results": [], "next": self.hub.base + "?page_size=100"}):
            with self.assertRaises(ValueError):
                self.hub.tags()

    def test_malformed_registry_payload_fails(self):
        for payload in ([], {}, {"results": "bad"}, {"results": [None]}, {"results": [{}]}, {"results": [], "next": 1}):
            with self.subTest(payload=payload), patch.object(self.hub, "read", return_value=payload), self.assertRaises(ValueError):
                self.hub.tags()

    def test_untrusted_urls_do_not_make_requests(self):
        for url in ("http://hub.docker.com/x", "https://example.invalid/", "https://hub.docker.com@evil.invalid/x", "https://hub.docker.com/v2/repositories/other/image/tags/"):
            with self.subTest(url=url), patch.object(release.urllib.request, "urlopen") as request:
                with self.assertRaises(ValueError):
                    self.hub.read(url)
                request.assert_not_called()

    def test_registry_errors_do_not_look_like_missing_versions(self):
        for status in (401, 403, 429, 500):
            error = urllib.error.HTTPError(self.hub.base, status, "fixture", {}, io.BytesIO())
            with self.subTest(status=status), patch.object(release.urllib.request, "urlopen", side_effect=error), self.assertRaises(urllib.error.HTTPError):
                self.hub.read(self.hub.base, missing=True)

    def test_only_explicit_missing_tag_accepts_404(self):
        error = urllib.error.HTTPError(self.hub.base, 404, "fixture", {}, io.BytesIO())
        with patch.object(release.urllib.request, "urlopen", side_effect=error):
            self.assertIsNone(self.hub.read(self.hub.base, missing=True))
            with self.assertRaises(urllib.error.HTTPError):
                self.hub.read(self.hub.base)


class RegistryTest(unittest.TestCase):
    @staticmethod
    def token_response(token="anonymous-pull-token"):
        return io.BytesIO(json.dumps({"token": token}).encode())

    @staticmethod
    def manifest_response(value):
        response = io.BytesIO()
        response.headers = {"Docker-Content-Digest": value}
        return response

    def test_resolves_exact_manifest_digest_with_head_request(self):
        expected = digest("manifest")
        with patch.object(release.urllib.request, "urlopen", side_effect=[self.token_response(), self.manifest_response(expected)]) as request:
            self.assertEqual(release.registry_digest("koshsky/erp-backend:v1.4.4"), expected)
            head = request.call_args_list[1].args[0]
            self.assertEqual(head.get_method(), "HEAD")
            self.assertIn("application/vnd.oci.image.index.v1+json", head.get_header("Accept"))
            self.assertEqual(head.get_header("Authorization"), "Bearer anonymous-pull-token")

    def test_only_missing_manifest_accepts_404(self):
        for status in (401, 403, 404, 429, 500):
            error = urllib.error.HTTPError("https://registry-1.docker.io", status, "fixture", {}, io.BytesIO())
            with self.subTest(status=status), patch.object(release.urllib.request, "urlopen", side_effect=[self.token_response(), error]):
                if status == 404:
                    self.assertIsNone(release.registry_digest("koshsky/erp-backend:latest", missing=True))
                else:
                    with self.assertRaises(urllib.error.HTTPError):
                        release.registry_digest("koshsky/erp-backend:latest", missing=True)

    def test_required_manifest_404_fails(self):
        error = urllib.error.HTTPError("https://registry-1.docker.io", 404, "fixture", {}, io.BytesIO())
        with patch.object(release.urllib.request, "urlopen", side_effect=[self.token_response(), error]), self.assertRaises(urllib.error.HTTPError):
            release.registry_digest("koshsky/erp-backend:v1.4.4")

    def test_invalid_reference_never_makes_network_requests(self):
        for reference in ("evil.invalid/repo:v1.4.4", "koshsky/erp-backend:prod", "koshsky/erp-backend:stable", "koshsky/erp-backend:staging", "koshsky/erp-backend:v1.4.04", "koshsky/erp-backend:latest\n", "koshsky/erp-backend:staging\n"):
            with self.subTest(reference=reference), patch.object(release.urllib.request, "urlopen") as request:
                with self.assertRaises(ValueError):
                    release.registry_digest(reference)
                request.assert_not_called()

    def test_invalid_manifest_digest_fails(self):
        for value in (None, "", "sha256:invalid", digest("fixture") + "\n"):
            with self.subTest(value=value), patch.object(release.urllib.request, "urlopen", side_effect=[self.token_response(), self.manifest_response(value)]), self.assertRaises(ValueError):
                release.registry_digest("koshsky/erp-backend:latest")

    def test_latest_digest_can_be_read(self):
        expected = digest("latest")
        with patch.object(release.urllib.request, "urlopen", side_effect=[self.token_response(), self.manifest_response(expected)]):
            self.assertEqual(release.registry_digest("koshsky/erp-backend:latest"), expected)

    def test_missing_registry_token_fails(self):
        for value in (None, "", 123):
            with self.subTest(value=value), patch.object(release.urllib.request, "urlopen", return_value=self.token_response(value)), self.assertRaises(ValueError):
                release.registry_digest("koshsky/erp-backend:latest")


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "frontend").mkdir()
        (self.root / "backend").mkdir()
        self.frontend_version("1.6.4")
        (self.root / "backend/VERSION").write_text("1.4.4\n")
        self.path = self.root / "release-plan.json"
        self.hub = FakeHub()
        self.docker = FakeDocker()
        self.docker.remote.update({repository + ":staging": value for repository, value in self.hub.staging.items()})
        self.docker.remote.update({repository + ":latest": digest(repository + " old latest") for repository in self.hub.versions})
        def read_digest(reference, missing=False):
            if reference in self.docker.remote:
                return self.docker.remote[reference]
            if missing:
                return None
            raise ValueError("Missing registry reference")
        registry = patch.object(release, "registry_digest", side_effect=read_digest)
        registry.start()
        self.addCleanup(registry.stop)
        mock = patch.object(release, "run", self.docker)
        mock.start()
        self.addCleanup(mock.stop)

    def frontend_version(self, version):
        (self.root / "frontend/package.json").write_text(json.dumps({"version": version}))

    def plan(self, component="both"):
        plan = release.prepare(component, self.root, self.hub)
        release.save(plan, self.path)
        return plan

    def published(self):
        plan = self.plan()
        release.build(plan, self.path, self.root)
        release.publish(plan, self.path, self.hub)
        return plan

    def mutations(self, verb):
        return [args for args in self.docker.commands if verb in args]

    def test_reads_canonical_files_and_preserves_sources(self):
        original = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        plan = self.plan()
        self.assertEqual([entry["version"] for entry in plan["services"]], ["1.6.4", "1.4.4"])
        self.assertEqual([entry["previous_version"] for entry in plan["services"]], ["1.6.3", "1.4.3"])
        self.assertEqual(plan["revision"], REVISION)
        for path, body in original.items():
            self.assertEqual(path.read_bytes(), body)

    def test_selected_service_ignores_other_service_version(self):
        (self.root / "backend/VERSION").write_text("invalid")
        self.assertEqual(len(self.plan("frontend")["services"]), 1)
        self.frontend_version("invalid")
        (self.root / "backend/VERSION").write_text("1.4.4")
        self.assertEqual(len(self.plan("backend")["services"]), 1)

    def test_any_invalid_selected_version_stops_before_build(self):
        (self.root / "backend/VERSION").write_text("1.6.1")
        with self.assertRaises(ValueError):
            self.plan()
        self.assertFalse(self.mutations("build"))
        self.assertFalse(self.mutations("push"))

    def test_current_published_version_cannot_be_rebuilt(self):
        self.frontend_version("1.6.3")
        with self.assertRaises(ValueError):
            self.plan("frontend")
        self.assertFalse(self.mutations("build"))

    def test_build_uses_file_version_architecture_labels_and_same_origin_api(self):
        plan = self.plan()
        release.build(plan, self.path, self.root)
        commands = self.mutations("build")
        self.assertEqual(len(commands), 2)
        for entry, args in zip(plan["services"], commands):
            self.assertIn("APP_VERSION=" + entry["version"], args)
            self.assertIn("org.opencontainers.image.revision=" + REVISION, args)
            self.assertEqual(args[args.index("--platform") + 1], "linux/amd64")
            self.assertEqual(args[args.index("--tag") + 1], entry["tag"])
        self.assertIn("VITE_API_URL=/api/v1", commands[0])
        self.assertNotIn("VITE_API_URL=/api/v1", commands[1])
        self.assertFalse(self.mutations("push"))
        self.assertFalse(self.mutations("create"))

    def test_successful_release_promotes_exact_published_digests_without_rebuild(self):
        plan = self.published()
        release.promote(plan, self.path)
        self.assertEqual(len(self.mutations("build")), 2)
        self.assertEqual(len(self.mutations("push")), 2)
        creates = self.mutations("create")
        self.assertEqual(len(creates), 2)
        for entry, args in zip(plan["services"], creates):
            self.assertIn("--prefer-index=false", args)
            self.assertEqual(args[-1], entry["repository"] + "@" + entry["digest"])
            self.assertEqual(args[args.index("--tag") + 1], entry["repository"] + ":latest")
            self.assertEqual(self.docker.remote[entry["repository"] + ":latest"], entry["digest"])
            self.assertTrue(entry["latest_updated"])
        self.assertFalse(any(":prod" in str(args) for args in self.docker.commands))

    def test_changed_latest_stops_all_components_before_promotion(self):
        plan = self.published()
        self.docker.remote["koshsky/erp-backend:latest"] = digest("another promotion")
        with self.assertRaises(ValueError):
            release.promote(plan, self.path)
        self.assertFalse(self.mutations("create"))

    def test_stable_and_legacy_aliases_are_never_read_or_changed(self):
        protected = {repository + ":" + tag: digest(repository + tag)
                     for repository in release.REPOSITORIES.values() for tag in ("stable", "prod", "staging")}
        self.docker.remote.update(protected)
        plan = self.published()
        release.promote(plan, self.path)
        for reference, original in protected.items():
            self.assertEqual(self.docker.remote[reference], original)
        references = [call.args[0] for call in release.registry_digest.call_args_list]
        self.assertTrue(all(reference not in protected for reference in references))
        for command in self.mutations("create"):
            self.assertTrue(command[command.index("--tag") + 1].endswith(":latest"))

    def test_absent_stable_and_legacy_aliases_are_not_created(self):
        self.docker.remote.clear()
        plan = self.published()
        release.promote(plan, self.path)
        self.assertEqual(set(self.docker.remote),
                         {entry["tag"] for entry in plan["services"]} |
                         {entry["repository"] + ":latest" for entry in plan["services"]})

    def test_missing_latest_can_be_created(self):
        for repository in release.REPOSITORIES.values():
            del self.docker.remote[repository + ":latest"]
        plan = self.published()
        release.promote(plan, self.path)
        self.assertTrue(all(entry["latest_updated"] for entry in plan["services"]))

    def test_selected_component_promotes_only_its_aliases(self):
        plan = self.plan("frontend")
        release.build(plan, self.path, self.root)
        release.publish(plan, self.path, self.hub)
        release.promote(plan, self.path)
        self.assertEqual(len(self.mutations("create")), 1)
        self.assertTrue(all("erp-frontend:" in args[args.index("--tag") + 1] for args in self.mutations("create")))

    def test_latest_failure_retains_previous_digest_without_reporting_success(self):
        plan = self.published()
        self.docker.fail = lambda args: "create" in args and any(arg.endswith("erp-frontend:latest") for arg in args)
        with self.assertRaises(subprocess.CalledProcessError):
            release.promote(plan, self.path)
        report = json.loads(self.path.read_text())
        self.assertNotIn("staging_updated", report["services"][0])
        self.assertNotIn("latest_updated", report["services"][0])
        self.assertNotIn("latest_updated", report["services"][1])
        self.assertEqual(report["services"][0]["previous_latest_digest"], plan["services"][0]["previous_latest_digest"])

    def test_latest_digest_mismatch_is_not_reported_as_success(self):
        plan = self.published()
        read = release.registry_digest.side_effect
        def corrupt_latest(reference, missing=False):
            if reference.endswith(":latest") and any("create" in command for command in self.docker.commands):
                return digest("incorrect latest")
            return read(reference, missing=missing)
        release.registry_digest.side_effect = corrupt_latest
        with self.assertRaises(ValueError):
            release.promote(plan, self.path)
        self.assertNotIn("latest_updated", json.loads(self.path.read_text())["services"][0])

    def test_plan_requires_valid_previous_latest_digest(self):
        plan = self.plan()
        for value in ("invalid", "missing"):
            changed = copy.deepcopy(plan)
            if value == "missing":
                del changed["services"][0]["previous_latest_digest"]
            else:
                changed["services"][0]["previous_latest_digest"] = value
            release.save(changed, self.path)
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.load(self.path, self.root)

    def test_missing_staging_tag_is_not_recreated(self):
        for repository in release.REPOSITORIES.values():
            self.docker.remote.pop(repository + ":staging")
        plan = self.published()
        release.promote(plan, self.path)
        self.assertTrue(all(entry.get("latest_updated") for entry in plan["services"]))
        self.assertTrue(all(repository + ":staging" not in self.docker.remote for repository in release.REPOSITORIES.values()))

    def test_new_publication_during_build_stops_all_pushes(self):
        plan = self.plan()
        release.build(plan, self.path, self.root)
        self.hub.versions["koshsky/erp-backend"].append("v1.5.0")
        with self.assertRaises(ValueError):
            release.publish(plan, self.path, self.hub)
        self.assertFalse(self.mutations("push"))

    def test_missing_or_replaced_built_image_stops_all_pushes(self):
        plan = self.plan()
        with self.assertRaises(ValueError):
            release.publish(plan, self.path, self.hub)
        release.build(plan, self.path, self.root)
        self.docker.local[plan["services"][1]["tag"]] = digest("replaced")
        with self.assertRaises(ValueError):
            release.publish(plan, self.path, self.hub)
        self.assertFalse(self.mutations("push"))

    def test_push_failure_never_promotes_latest(self):
        plan = self.plan()
        release.build(plan, self.path, self.root)
        self.docker.fail = lambda args: args[:2] == ["docker", "push"] and "backend" in args[2]
        with self.assertRaises(subprocess.CalledProcessError):
            release.publish(plan, self.path, self.hub)
        self.assertFalse(self.mutations("create"))
        report = json.loads(self.path.read_text())
        self.assertIn("digest", report["services"][0])
        self.assertNotIn("digest", report["services"][1])

    def test_incomplete_publication_cannot_promote_either_service(self):
        plan = self.published()
        del plan["services"][1]["digest"]
        with self.assertRaises(ValueError):
            release.promote(plan, self.path)
        self.assertFalse(self.mutations("create"))

    def test_changed_version_tag_cannot_promote(self):
        plan = self.published()
        self.docker.remote[plan["services"][1]["tag"]] = digest("replaced")
        with self.assertRaises(ValueError):
            release.promote(plan, self.path)
        self.assertFalse(self.mutations("create"))

    def test_changed_staging_is_not_overwritten(self):
        plan = self.published()
        previous = digest("someone else promoted")
        self.docker.remote["koshsky/erp-backend:staging"] = previous
        release.promote(plan, self.path)
        self.assertEqual(self.docker.remote["koshsky/erp-backend:staging"], previous)

    def test_wrong_promotion_digest_is_not_reported_as_success(self):
        plan = self.published()
        self.docker.corrupt_promotion = True
        with self.assertRaises(ValueError):
            release.promote(plan, self.path)
        self.assertNotIn("latest_updated", json.loads(self.path.read_text())["services"][0])

    def test_partial_promotion_report_keeps_previous_and_completed_digests(self):
        plan = self.published()
        self.docker.fail = lambda args: "create" in args and any(arg.endswith("erp-backend:latest") for arg in args)
        with self.assertRaises(subprocess.CalledProcessError):
            release.promote(plan, self.path)
        report = json.loads(self.path.read_text())
        self.assertTrue(report["services"][0]["latest_updated"])
        self.assertNotIn("latest_updated", report["services"][1])
        self.assertIn("previous_latest_digest", report["services"][0])

    def test_existing_registry_tag_is_not_overwritten_when_hub_listing_lags(self):
        plan = self.plan()
        release.build(plan, self.path, self.root)
        self.docker.remote[plan["services"][1]["tag"]] = digest("published elsewhere")
        with self.assertRaises(ValueError):
            release.publish(plan, self.path, self.hub)
        self.assertFalse(self.mutations("push"))

    def test_existing_registry_tag_stops_planning_before_build(self):
        self.docker.remote["koshsky/erp-frontend:v1.6.4"] = digest("published elsewhere")
        with self.assertRaises(ValueError):
            self.plan("frontend")
        self.assertFalse(self.mutations("build"))

    def test_plan_cannot_change_repository_tag_revision_or_file_version(self):
        original = self.plan()
        for field, value in (("repository", "other/repository"), ("tag", "koshsky/erp-frontend:staging"), ("version", "1.7.1"), ("digest", "invalid")):
            changed = copy.deepcopy(original)
            changed["services"][0][field] = value
            release.save(changed, self.path)
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.load(self.path, self.root)
        changed = copy.deepcopy(original)
        changed["revision"] = "b" * 40
        release.save(changed, self.path)
        with self.assertRaises(ValueError):
            release.load(self.path, self.root)
        release.save(original, self.path)
        self.frontend_version("1.6.5")
        with self.assertRaises(ValueError):
            release.load(self.path, self.root)

    def test_non_main_cli_never_builds_or_publishes(self):
        for command in ("plan", "build", "publish", "promote"):
            with self.subTest(command=command), patch.dict(os.environ, {"GITHUB_REF": "refs/heads/feature"}), patch.object(release.sys, "argv", [str(SCRIPT), command, "--plan", str(self.path)]):
                with self.assertRaises(ValueError):
                    release.main()
        self.assertEqual(self.docker.commands, [])
