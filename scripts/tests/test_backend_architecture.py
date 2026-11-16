import importlib.util
import json
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "check-backend-architecture.py"
SPEC = importlib.util.spec_from_file_location("architecture", SCRIPT)
architecture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(architecture)


def graph():
    return {
        architecture.INTERNAL + name: {"ImportPath": architecture.INTERNAL + name, "GoFiles": ["core.go"], "Imports": []}
        for name in architecture.CORES
    }


def node(packages, name, imports=(), **extra):
    packages[name] = {"ImportPath": name, "GoFiles": ["source.go"], "Imports": list(imports), **extra}


class ArchitectureTest(unittest.TestCase):
    def test_rejects_direct_and_transitive_core_violations(self):
        prefix = architecture.INTERNAL
        targets = [
            "github.com/gin-gonic/gin", "github.com/gin-contrib/cors",
            prefix + "middleware/rbac", prefix + "userctx", prefix + "project_mgmt/task/delivery",
            prefix + "project_mgmt/task/repository", prefix + "other/repository/nested",
            prefix + "project_mgmt/task/repository/sqlc/adapter",
            prefix + "other/repository/nested/repository/sqlc",
        ]
        for core in architecture.CORES:
            for target in targets:
                for transitive in (False, True):
                    with self.subTest(core=core, target=target, transitive=transitive):
                        packages = graph()
                        node(packages, target)
                        origin = prefix + core
                        if transitive:
                            helper = prefix + "helpers"
                            node(packages, helper, [target])
                            packages[origin]["Imports"] = [helper]
                        else:
                            packages[origin]["Imports"] = [target]
                        with self.assertRaisesRegex(ValueError, "core depends") as failure:
                            architecture.check_graph(packages)
                        self.assertIn(origin + " -> ", str(failure.exception))
                        self.assertIn(target, str(failure.exception))

    def test_sql_adapters_reject_http_and_dto_dependencies(self):
        prefix = architecture.INTERNAL
        for target in [prefix + "auto_create/dto", prefix + "other/dto/nested", prefix + "user/delivery", "github.com/gin-gonic/gin"]:
            for transitive in (False, True):
                with self.subTest(target=target, transitive=transitive):
                    packages = graph()
                    node(packages, target)
                    helper = prefix + "helpers"
                    node(packages, helper, [target])
                    node(packages, prefix + "auto_create/repository", [helper if transitive else target])
                    with self.assertRaisesRegex(ValueError, "SQL adapter depends"):
                        architecture.check_graph(packages)

    def test_own_sqlc_and_http_dtos_remain_valid_core_currency(self):
        for core in architecture.CORES:
            with self.subTest(core=core):
                packages = graph()
                owner = core if core in architecture.FEATURES or "/" not in core else core.rsplit("/", 1)[0]
                for dependency in [architecture.INTERNAL + owner + "/repository/sqlc", architecture.INTERNAL + owner + "/dto"]:
                    node(packages, dependency)
                    packages[architecture.INTERNAL + core]["Imports"].append(dependency)
                self.assertEqual(architecture.check_graph(packages)["selected_cores"], len(architecture.CORES))

    def test_foreign_sqlc_cannot_replace_a_consumer_owned_port(self):
        for core in architecture.CORES:
            with self.subTest(core=core):
                packages = graph()
                foreign = architecture.INTERNAL + "unrelated/repository/sqlc"
                node(packages, foreign)
                packages[architecture.INTERNAL + core]["Imports"] = [foreign]
                with self.assertRaisesRegex(ValueError, "core imports foreign sqlc"):
                    architecture.check_graph(packages)

    def test_composition_and_real_http_clients_are_not_misclassified_as_cores(self):
        prefix = architecture.INTERNAL
        for adapter in ["server", "auth", "authz", "auto_create", "user", "planning", "project_mgmt", "timesheet", "audit", "security/hibp"]:
            with self.subTest(adapter=adapter):
                packages = graph()
                node(packages, "github.com/gin-gonic/gin")
                node(packages, prefix + adapter, ["github.com/gin-gonic/gin"])
                architecture.check_graph(packages)

    def test_http_test_imports_do_not_become_production_edges(self):
        for field in ("TestImports", "XTestImports"):
            with self.subTest(field=field):
                packages = graph()
                packages[architecture.INTERNAL + "authz/service"][field] = [
                    "github.com/gin-gonic/gin", architecture.INTERNAL + "authz/repository",
                ]
                architecture.check_graph(packages)

    def test_cgo_pseudo_import_does_not_require_go_package_metadata(self):
        packages = graph()
        core = packages[architecture.INTERNAL + "tracing"]
        core.update(GoFiles=[], CgoFiles=["native.go"], Imports=["C"])
        decoded = architecture.decode_packages("\n".join(json.dumps(row) for row in packages.values()))
        self.assertEqual(architecture.check_graph(decoded)["production_packages"], len(architecture.CORES))

    def test_cgo_only_sql_adapters_still_obey_http_boundaries(self):
        packages = graph()
        dto = architecture.INTERNAL + "auto_create/dto"
        node(packages, dto)
        node(packages, architecture.INTERNAL + "auto_create/repository", ["C", dto], GoFiles=[], CgoFiles=["native.go"])
        with self.assertRaisesRegex(ValueError, "SQL adapter depends on HTTP/DTO"):
            architecture.check_graph(packages)

    def test_missing_cores_and_dependency_metadata_fail_closed(self):
        packages = graph()
        del packages[architecture.INTERNAL + "tracing"]
        with self.assertRaisesRegex(ValueError, "missing selected cores"):
            architecture.check_graph(packages)
        packages = graph()
        packages[architecture.INTERNAL + "tracing"]["Imports"] = ["unknown/dependency"]
        with self.assertRaisesRegex(ValueError, "missing dependency metadata"):
            architecture.check_graph(packages)

    def test_traversal_handles_cycles_and_reports_transitive_paths(self):
        packages = graph()
        a, b = architecture.INTERNAL + "helpers/a", architecture.INTERNAL + "helpers/b"
        node(packages, a, [b]); node(packages, b, [a])
        packages[architecture.INTERNAL + "tracing"]["Imports"] = [a]
        architecture.check_graph(packages)
        node(packages, "github.com/gin-gonic/gin")
        packages[b]["Imports"].append("github.com/gin-gonic/gin")
        with self.assertRaisesRegex(ValueError, "helpers/a -> .*helpers/b -> github.com/gin-gonic/gin"):
            architecture.check_graph(packages)


class PackageInputTest(unittest.TestCase):
    def test_decodes_stream_and_does_not_treat_test_only_packages_as_production(self):
        packages = graph()
        node(packages, architecture.INTERNAL + "architecture", GoFiles=[], XTestImports=["github.com/gin-gonic/gin"])
        text = "\n".join(json.dumps(row) for row in packages.values())
        decoded = architecture.decode_packages(text)
        self.assertEqual(architecture.check_graph(decoded)["production_packages"], len(architecture.CORES))

    def test_rejects_incomplete_malformed_or_ambiguous_metadata(self):
        row = {"ImportPath": "example/package", "GoFiles": ["file.go"]}
        invalid = [
            "", "not JSON", "[]", "{}", json.dumps({**row, "ImportPath": ""}),
            json.dumps(row) + json.dumps(row), json.dumps(row) + "trailing garbage",
            *[json.dumps({**row, **value}) for value in [
                {"Error": {"Err": "parse failed"}}, {"Error": {}}, {"Incomplete": True},
                {"DepsErrors": [{"Err": "missing package"}]}, {"Imports": "bad"},
                {"Imports": [None]}, {"GoFiles": ["hidden_test.go"]}, {"XTestImports": [""]},
                {"CgoFiles": ["hidden_test.go"]}, {"CgoFiles": "bad"},
            ]],
        ]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(ValueError):
                architecture.decode_packages(text)


if __name__ == "__main__":
    unittest.main()
