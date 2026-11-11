#!/usr/bin/env python3
"""Validate changed PR versions against published Docker images, allowing code changes."""

import json
import os
from pathlib import Path
import subprocess
import sys

import release


VERSION_FILES = {"frontend": "frontend/package.json", "backend": "backend/VERSION"}


def git(root, *arguments):
    return subprocess.check_output(["git", *arguments], cwd=root, text=True, stderr=subprocess.PIPE).strip()


def version_at(root, revision, service, optional=False):
    path = VERSION_FILES[service]
    if optional and not git(root, "ls-tree", revision, "--", path):
        return None
    value = git(root, "show", revision + ":" + path)
    return json.loads(value)["version"] if service == "frontend" else value


def check(event, root=release.ROOT, hub_factory=release.Hub):
    base = event["pull_request"]["base"]["sha"]
    head = event["pull_request"]["head"]["sha"]
    if any(not isinstance(value, str) or not release.SHA.fullmatch(value) for value in (base, head)):
        raise ValueError("Invalid PR commit SHA")
    ancestor = git(root, "merge-base", base, head)
    changed = {}
    for service in VERSION_FILES:
        candidate = version_at(root, head, service)
        release.parse_version(candidate)
        # Target-branch advances must not turn an unrelated PR into a version bump.
        if candidate != version_at(root, ancestor, service, optional=True):
            changed[service] = candidate
    report = {}
    for service, candidate in changed.items():
        repository = release.REPOSITORIES[service]
        tags = hub_factory(repository).tags()
        previous = release.latest_version(tags)
        release.validate_step(previous, candidate)
        tag = repository + ":v" + candidate
        if "v" + candidate in tags or release.registry_digest(tag, missing=True) is not None:
            raise ValueError("Version tag already exists: " + tag)
        report[service] = {"published": previous, "candidate": candidate}
    return report


def main():
    if os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        raise ValueError("PR version checks require a pull_request event")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    report = check(event)
    print(json.dumps(report, indent=2) if report else "No version changes; no Docker Hub queries required")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
