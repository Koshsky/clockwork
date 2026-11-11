#!/usr/bin/env python3
"""Manually release file-versioned images without modifying source files."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
REPOSITORIES = {"frontend": "koshsky/erp-frontend", "backend": "koshsky/erp-backend"}
MOVING_TAGS = ("latest",)
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?\Z")


def parse_version(value):
    if not isinstance(value, str) or len(value) > 127 or not VERSION.fullmatch(value):
        raise ValueError(f"Expected a stable SemVer X.Y.Z without a v prefix: {value!r}")
    return tuple(int(part) for part in value.split("."))


def next_versions(previous):
    major, minor, patch = parse_version(previous)
    return (f"{major}.{minor}.{patch + 1}", f"{major}.{minor + 1}.0", f"{major + 1}.0.0")


def validate_step(previous, candidate):
    parse_version(candidate)
    allowed = next_versions(previous)
    if candidate not in allowed:
        raise ValueError(f"After {previous}, only {', '.join(allowed)} are allowed; got {candidate}")


def latest_version(tags):
    versions = []
    for tag in tags:
        if isinstance(tag, str) and tag.startswith("v") and VERSION.fullmatch(tag[1:]):
            versions.append((parse_version(tag[1:]), tag[1:]))
    if not versions:
        raise ValueError("Docker Hub has no published stable vX.Y.Z baseline")
    return max(versions)[1]


def file_version(service, root=ROOT):
    if service == "frontend":
        value = json.loads((root / "frontend/package.json").read_text())["version"]
    elif service == "backend":
        value = (root / "backend/VERSION").read_text().strip()
    else:
        raise ValueError("Unknown service: " + service)
    parse_version(value)
    return value


class Hub:
    def __init__(self, repository):
        if repository not in REPOSITORIES.values():
            raise ValueError("Unknown Docker repository")
        self.repository = repository
        self.base = f"https://hub.docker.com/v2/repositories/{repository}/tags/"

    def read(self, url, missing=False):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "hub.docker.com" or not url.startswith(self.base):
            raise ValueError("Unexpected Docker Hub pagination URL")
        request = urllib.request.Request(url, headers={"User-Agent": "clockwork-release"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise

    def tags(self):
        url = self.base + "?page_size=100"
        names, seen = [], set()
        while url:
            if url in seen or len(seen) >= 1000:
                raise ValueError("Invalid Docker Hub pagination")
            seen.add(url)
            page = self.read(url)
            if not isinstance(page, dict) or not isinstance(page.get("results"), list):
                raise ValueError("Invalid Docker Hub tags response")
            for tag in page["results"]:
                if not isinstance(tag, dict) or not isinstance(tag.get("name"), str):
                    raise ValueError("Invalid Docker Hub tag")
                names.append(tag["name"])
            url = page.get("next")
            if url is not None and not isinstance(url, str):
                raise ValueError("Invalid Docker Hub next page")
        return names



def run(arguments, capture=False):
    result = subprocess.run(arguments, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def registry_digest(reference, missing=False):
    repository, separator, tag = reference.rpartition(":")
    if not separator or repository not in REPOSITORIES.values():
        raise ValueError("Unknown registry reference")
    if tag not in MOVING_TAGS:
        if not tag.startswith("v"):
            raise ValueError("Unknown registry tag")
        parse_version(tag[1:])
    query = urllib.parse.urlencode({"service": "registry.docker.io", "scope": f"repository:{repository}:pull"})
    with urllib.request.urlopen("https://auth.docker.io/token?" + query, timeout=30) as response:
        token = json.load(response).get("token")
    if not isinstance(token, str) or not token:
        raise ValueError("Missing Docker registry pull token")
    request = urllib.request.Request(
        f"https://registry-1.docker.io/v2/{repository}/manifests/{tag}", method="HEAD",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": ", ".join((
                "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
                "application/vnd.docker.distribution.manifest.v2+json",
            )),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = response.headers.get("Docker-Content-Digest")
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise
    if not isinstance(result, str) or not DIGEST.fullmatch(result):
        raise ValueError("Invalid registry digest: " + reference)
    return result


def save(plan, path):
    path.write_text(json.dumps(plan, indent=2) + "\n")


def prepare(component, root=ROOT, hub_factory=Hub):
    names = list(REPOSITORIES) if component == "both" else [component]
    revision = run(["git", "-C", str(root), "rev-parse", "HEAD"], capture=True)
    if not SHA.fullmatch(revision):
        raise ValueError("Invalid source revision")
    plan = {"schema": 1, "revision": revision, "services": []}
    for name in names:
        repository = REPOSITORIES[name]
        hub = hub_factory(repository)
        version = file_version(name, root)
        tags = hub.tags()
        previous = latest_version(tags)
        validate_step(previous, version)
        if "v" + version in tags:
            raise ValueError("Version tag already exists: " + repository + ":v" + version)
        if registry_digest(repository + ":v" + version, missing=True) is not None:
            raise ValueError("Version tag already exists in the registry: " + repository + ":v" + version)
        plan["services"].append({
            "name": name, "repository": repository, "version": version,
            "previous_version": previous, "tag": repository + ":v" + version,
            **{"previous_" + tag + "_digest": registry_digest(repository + ":" + tag, missing=True)
               for tag in MOVING_TAGS},
        })
    return plan


def load(path, root=ROOT):
    plan = json.loads(path.read_text())
    if plan.get("schema") != 1 or not SHA.fullmatch(plan.get("revision", "")):
        raise ValueError("Invalid release plan")
    services = plan.get("services")
    if not isinstance(services, list) or not services or len(services) > len(REPOSITORIES):
        raise ValueError("Invalid release selection")
    seen = set()
    for entry in services:
        name = entry["name"]
        if name not in REPOSITORIES or name in seen or entry["repository"] != REPOSITORIES[name]:
            raise ValueError("Invalid release repository")
        seen.add(name)
        validate_step(entry["previous_version"], entry["version"])
        if entry["version"] != file_version(name, root) or entry["tag"] != entry["repository"] + ":v" + entry["version"]:
            raise ValueError("Release plan differs from the source version")
        for tag in MOVING_TAGS:
            if "previous_" + tag + "_digest" not in entry:
                raise ValueError("Missing previous tag digest: " + tag)
        for key in ("image_id", "digest", *("previous_" + tag + "_digest" for tag in MOVING_TAGS)):
            value = entry.get(key)
            if value is not None and (not isinstance(value, str) or not DIGEST.fullmatch(value)):
                raise ValueError("Invalid image digest: " + key)
    revision = run(["git", "-C", str(root), "rev-parse", "HEAD"], capture=True)
    if plan["revision"] != revision:
        raise ValueError("Release plan belongs to a different source revision")
    return plan


def build(plan, path, root=ROOT):
    for entry in plan["services"]:
        arguments = [
            "docker", "buildx", "build", "--load", "--platform", "linux/amd64",
            "--tag", entry["tag"], "--build-arg", "APP_VERSION=" + entry["version"],
            "--label", "org.opencontainers.image.version=" + entry["version"],
            "--label", "org.opencontainers.image.revision=" + plan["revision"],
            "--label", "org.opencontainers.image.source=https://github.com/Koshsky/clockwork",
        ]
        if entry["name"] == "frontend":
            arguments += ["--build-arg", "VITE_API_URL=/api/v1", "--build-arg", "VITE_API_BASE=/api/v1"]
        run(arguments + [str(root / entry["name"])])
        entry["image_id"] = run(["docker", "image", "inspect", entry["tag"], "--format", "{{.Id}}"], capture=True)
        if not DIGEST.fullmatch(entry["image_id"]):
            raise ValueError("Invalid built image ID")
        save(plan, path)


def publish(plan, path, hub_factory=Hub):
    # Validate the entire selection again before any immutable version tag is pushed.
    for entry in plan["services"]:
        current = latest_version(hub_factory(entry["repository"]).tags())
        if current != entry["previous_version"]:
            raise ValueError("Published versions changed during the build: " + entry["repository"])
        if registry_digest(entry["tag"], missing=True) is not None:
            raise ValueError("Version tag already exists in the registry: " + entry["tag"])
        if not entry.get("image_id"):
            raise ValueError("Image has not been built: " + entry["tag"])
        actual = run(["docker", "image", "inspect", entry["tag"], "--format", "{{.Id}}"], capture=True)
        if actual != entry["image_id"]:
            raise ValueError("Built image was replaced: " + entry["tag"])
    for entry in plan["services"]:
        run(["docker", "push", entry["tag"]])
        entry["digest"] = registry_digest(entry["tag"])
        save(plan, path)


def promote(plan, path):
    # Validate the entire selection before changing any moving tag.
    for entry in plan["services"]:
        if not entry.get("digest") or registry_digest(entry["tag"]) != entry["digest"]:
            raise ValueError("Published image differs from the release plan: " + entry["tag"])
        for tag in MOVING_TAGS:
            if registry_digest(entry["repository"] + ":" + tag, missing=True) != entry["previous_" + tag + "_digest"]:
                raise ValueError(tag + " changed during the release: " + entry["repository"])
    for entry in plan["services"]:
        for tag in MOVING_TAGS:
            run([
                "docker", "buildx", "imagetools", "create", "--prefer-index=false",
                "--tag", entry["repository"] + ":" + tag, entry["repository"] + "@" + entry["digest"],
            ])
            if registry_digest(entry["repository"] + ":" + tag) != entry["digest"]:
                raise ValueError(tag + " digest verification failed: " + entry["repository"])
            entry[tag + "_updated"] = True
            save(plan, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "build", "publish", "promote"))
    parser.add_argument("--component", choices=(*REPOSITORIES, "both"), default="both")
    parser.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("Docker releases run only from main")
    if args.command == "plan":
        plan = prepare(args.component)
        save(plan, args.plan)
    else:
        plan = load(args.plan)
        {"build": build, "publish": publish, "promote": promote}[args.command](plan, args.plan)
    print(json.dumps(plan, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
