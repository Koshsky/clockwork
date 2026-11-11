#!/usr/bin/env python3
"""Select application checks independently of repository tooling and documentation."""

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
FLAGS = ("backend", "frontend", "api")
DETECTORS = {"backend": "backend-changes", "frontend": "frontend-changes", "api": "common-changes"}
SERVICE_RESULTS = {"backend": ("build_result", "lint_result"), "frontend": ("checks_result",)}
SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?\Z")


def classify(paths):
    selected = dict.fromkeys(FLAGS, False)
    for path in paths:
        if any(character in path for character in "\r\n\u2028\u2029"):
            raise ValueError("Unsupported line separator in changed path")
        name = PurePosixPath(path).name
        documentation = name in {"AGENTS.md", "README.md", "CONTRIBUTING.md"} or name.startswith("Changelog")
        if path.startswith("backend/") and not documentation and not path.endswith((".md", ".rst", ".txt")):
            selected["backend"] = True
        if path.startswith("frontend/") and not documentation:
            # Markdown imported by the UI is an application asset, not developer documentation.
            if not path.endswith((".md", ".rst", ".txt")) or path.startswith(("frontend/src/", "frontend/public/")):
                selected["frontend"] = True
        if path.startswith("backend/docs/swagger/") and path.endswith((".go", ".json", ".yaml", ".yml")):
            selected["api"] = True
        if (path.startswith("frontend/src/api/") and path.endswith(".ts")) or path in {
            "frontend/openapitools.json", "scripts/generate-api.sh",
        }:
            selected["api"] = True
    return selected


def detect(event_name, event, root=ROOT):
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        separator = "..."
    elif event_name == "push":
        base, head = event["before"], event["after"]
        separator = ".."
    else:
        raise ValueError("Unsupported CI event: " + event_name)
    if not isinstance(base, str) or not isinstance(head, str) or not SHA.fullmatch(base) or not SHA.fullmatch(head):
        raise ValueError("Invalid event commit SHA")
    if set(base) == {"0"}:
        return dict.fromkeys(FLAGS, True)
    try:
        paths = subprocess.check_output(
            ["git", "diff", "--no-renames", "--name-only", "-z", base + separator + head],
            cwd=root, stderr=subprocess.PIPE,
        ).decode("utf-8").split("\0")
    except subprocess.CalledProcessError:
        # A force-pushed-away base must never silently skip application checks.
        print("Comparison base unavailable; selecting all application checks", file=sys.stderr)
        return dict.fromkeys(FLAGS, True)
    return classify(path for path in paths if path)


def require_result(name, actual, expected):
    if actual != expected:
        raise ValueError(f"{name}: expected {expected}, got {actual}")


def verify(needs):
    require_result("common", needs.get("common", {}).get("result"), "success")
    outputs = {}
    for flag, detector in DETECTORS.items():
        detection = needs.get(detector, {})
        require_result(detector, detection.get("result"), "success")
        outputs[flag] = detection.get("outputs", {}).get(flag)
        if outputs[flag] not in ("true", "false"):
            raise ValueError("Invalid change detection output: " + flag)
    for service, results in SERVICE_RESULTS.items():
        selected = outputs[service] == "true"
        group = needs.get(service, {})
        require_result(service, group.get("result"), "success" if selected else "skipped")
        if selected:
            for result in results:
                require_result(service + "/" + result, group.get("outputs", {}).get(result), "success")
    common = needs["common"].get("outputs", {})
    require_result("common/policy", common.get("policy_result"), "success")
    require_result("common/api-client", common.get("api_result"),
                   "success" if outputs["api"] == "true" else "skipped")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("detect", "verify"))
    args = parser.parse_args()
    if args.command == "detect":
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        flags = detect(os.environ["GITHUB_EVENT_NAME"], event)
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for name, value in flags.items():
                output.write(f"{name}={str(value).lower()}\n")
        print(json.dumps(flags))
    else:
        verify(json.loads(os.environ["NEEDS_JSON"]))
        print("All selected checks passed; unselected checks were skipped")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
