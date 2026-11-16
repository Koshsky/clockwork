#!/usr/bin/env python3
"""Check production dependency boundaries; Go keeps test imports separate."""

from collections import deque
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
INTERNAL = "github.com/Koshsky/erp-backend/internal/"
FEATURES = (
    "project_mgmt/milestone", "project_mgmt/comment", "project_mgmt/assignment",
    "project_mgmt/project", "project_mgmt/process", "project_mgmt/task_dependency",
    "project_mgmt/task", "timesheet/state", "timesheet/resource", "timesheet/calendar",
)
CORES = FEATURES + (
    "authz/domain", "authz/engine", "authz/service", "auth/service",
    "auto_create/service", "user/domain", "user/service", "planning/service", "tracing",
)


def decode_packages(text):
    decoder, position, packages = json.JSONDecoder(), 0, {}
    while position < len(text):
        if text[position].isspace():
            position += 1
            continue
        package, position = decoder.raw_decode(text, position)
        if not isinstance(package, dict) or not isinstance(package.get("ImportPath"), str):
            raise ValueError("go list returned a package without an import path")
        name = package["ImportPath"]
        if not name or name in packages:
            raise ValueError("go list returned an empty or duplicate import path: " + name)
        if package.get("Incomplete") or package.get("Error") is not None or package.get("DepsErrors"):
            raise ValueError("go list returned an incomplete package: " + name)
        for field in ("Imports", "GoFiles", "TestImports", "XTestImports"):
            values = package.get(field, [])
            if not isinstance(values, list) or any(not isinstance(value, str) or not value for value in values):
                raise ValueError("invalid go list field " + field + ": " + name)
        if any(value.endswith("_test.go") for value in package.get("GoFiles", [])):
            raise ValueError("test source listed as production: " + name)
        packages[name] = package
    if not packages:
        raise ValueError("go list returned no packages")
    return packages


def local_path(name):
    return name.removeprefix(INTERNAL) if name.startswith(INTERNAL) else None


def is_http(name):
    local = local_path(name)
    return (
        name.startswith(("github.com/gin-gonic/", "github.com/gin-contrib/"))
        or local is not None and (
            "delivery" in local.split("/") or "middleware" in local.split("/") or local == "userctx"
        )
    )


def is_repository(name):
    local = local_path(name)
    parts = local.split("/") if local is not None else []
    return "repository" in parts and parts[parts.index("repository"):] != ["repository", "sqlc"]


def dependency_paths(packages, origin):
    pending, seen = deque([(origin, (origin,))]), {origin}
    while pending:
        name, path = pending.popleft()
        for dependency in sorted(packages[name].get("Imports", [])):
            if dependency in seen:
                continue
            seen.add(dependency)
            chain = path + (dependency,)
            yield dependency, chain
            if dependency not in packages:
                raise ValueError("missing dependency metadata: " + dependency)
            pending.append((dependency, chain))


def check_graph(packages):
    production = {name: row for name, row in packages.items() if row.get("GoFiles")}
    missing = [INTERNAL + core for core in CORES if INTERNAL + core not in production]
    if missing:
        raise ValueError("missing selected cores: " + ", ".join(missing))
    violations = set()
    for core in CORES:
        origin = INTERNAL + core
        owner = core if core in FEATURES or "/" not in core else core.rsplit("/", 1)[0]
        for dependency in packages[origin].get("Imports", []):
            if dependency.endswith("/repository/sqlc") and dependency != INTERNAL + owner + "/repository/sqlc":
                violations.add("core imports foreign sqlc: " + origin + " -> " + dependency)
        for dependency, chain in dependency_paths(packages, origin):
            if is_http(dependency) or is_repository(dependency):
                violations.add("core depends on HTTP/concrete repository: " + " -> ".join(chain))
    for origin in sorted(production):
        if not is_repository(origin):
            continue
        for dependency, chain in dependency_paths(packages, origin):
            local = local_path(dependency)
            if is_http(dependency) or local is not None and "dto" in local.split("/"):
                violations.add("SQL adapter depends on HTTP/DTO: " + " -> ".join(chain))
    if violations:
        raise ValueError("\n".join(sorted(violations)))
    internal = {name: row for name, row in production.items() if name.startswith(INTERNAL)}
    return {
        "production_packages": len(internal),
        "selected_cores": len(CORES),
        "sqlc_packages": sum(name.endswith("/repository/sqlc") for name in internal),
        "internal_import_edges": sum(dependency in internal for row in internal.values() for dependency in row.get("Imports", [])),
    }


def main():
    fields = "ImportPath,Imports,GoFiles,TestImports,XTestImports,Incomplete,Error,DepsErrors"
    result = subprocess.run(
        ["go", "list", "-p=2", "-deps", "-json=" + fields, "./internal/..."],
        cwd=ROOT / "backend", text=True, capture_output=True, check=True,
    )
    report = check_graph(decode_packages(result.stdout))
    print("PASS: backend architecture " + json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("FAIL: backend architecture: " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
