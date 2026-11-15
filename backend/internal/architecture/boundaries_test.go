package architecture_test

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestNeutralCoresDoNotDependOnHTTPAdapters(t *testing.T) {
	t.Parallel()

	cmd := exec.CommandContext(
		t.Context(),
		"go",
		"list",
		"-deps",
		"-f",
		"{{.ImportPath}}",
		"./internal/authz/domain",
		"./internal/authz/engine",
		"./internal/authz/service",
		"./internal/tracing",
		"./internal/auth/service",
		"./internal/user/domain",
		"./internal/project_mgmt/milestone",
		"./internal/timesheet/state",
		"./internal/timesheet/resource",
		"./internal/project_mgmt/comment",
		"./internal/project_mgmt/assignment",
		"./internal/project_mgmt/project",
		"./internal/project_mgmt/process",
		"./internal/project_mgmt/task_dependency",
		"./internal/project_mgmt/task",
	)
	cmd.Dir = "../.."
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("list core dependencies: %v\n%s", err, output)
	}
	for dependency := range strings.FieldsSeq(string(output)) {
		if strings.HasPrefix(dependency, "github.com/gin-gonic/") ||
			strings.HasPrefix(dependency, "github.com/Koshsky/erp-backend/internal/middleware/") ||
			dependency == "github.com/Koshsky/erp-backend/internal/userctx" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/timesheet/state/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/timesheet/resource/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository" ||
			dependency == "github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository" ||
			(strings.HasPrefix(dependency, "github.com/Koshsky/erp-backend/internal/") &&
				strings.Contains(dependency, "/delivery")) {
			t.Errorf("neutral core depends on HTTP adapter %s", dependency)
		}
	}
}

func TestUserLookupConsumersDoNotImportHTTPUserDTOs(t *testing.T) {
	t.Parallel()
	for _, directory := range []string{"../auth/service", "../audit", "../user/domain"} {
		entries, err := filepath.Glob(directory + "/*.go")
		if err != nil || len(entries) == 0 {
			t.Fatalf("lookup sources missing in %s: %v", directory, err)
		}
		for _, path := range entries {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			source, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if parseErr != nil {
				t.Fatal(parseErr)
			}
			for _, imported := range source.Imports {
				if imported.Path.Value == `"github.com/Koshsky/erp-backend/internal/user/dto"` {
					t.Errorf("%s depends on HTTP user DTOs", path)
				}
			}
		}
	}
}

func TestDataConsumersUseNeutralAccessContracts(t *testing.T) {
	t.Parallel()

	checked := 0
	err := filepath.WalkDir("..", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		name := filepath.ToSlash(path)
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") ||
			(!strings.Contains(name, "/service/") && !strings.Contains(name, "/repository/")) {
			return nil
		}
		checked++
		checkAccessImports(t, path, name)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked == 0 {
		t.Fatal("no service or repository sources were checked")
	}
}

func checkAccessImports(t *testing.T, path, name string) {
	t.Helper()

	source, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, imported := range source.Imports {
		dependency, unquoteErr := strconv.Unquote(imported.Path.Value)
		if unquoteErr != nil {
			t.Fatal(unquoteErr)
		}
		if dependency == "github.com/Koshsky/erp-backend/internal/userctx" {
			t.Errorf("%s depends on Gin principal accessors", name)
		}
		if dependency == "github.com/Koshsky/erp-backend/internal/middleware/rbac" {
			t.Errorf("%s depends on HTTP-owned access contracts", name)
		}
	}
}

func TestTaskAndDependencyCoresRetainConsumerBoundary(t *testing.T) {
	t.Parallel()
	for _, boundary := range []struct{ directory, forbidden string }{
		{"../project_mgmt/task", "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency"},
		{"../project_mgmt/task_dependency", "github.com/Koshsky/erp-backend/internal/project_mgmt/task"},
	} {
		files, err := filepath.Glob(boundary.directory + "/*.go")
		if err != nil || len(files) == 0 {
			t.Fatalf("core sources missing: %s, %v", boundary.directory, err)
		}
		for _, path := range files {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			checkSiblingImports(t, path, boundary.forbidden)
		}
	}
}

func checkSiblingImports(t *testing.T, path, forbidden string) {
	t.Helper()
	source, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
	if parseErr != nil {
		t.Fatal(parseErr)
	}
	for _, imported := range source.Imports {
		dependency, unquoteErr := strconv.Unquote(imported.Path.Value)
		if unquoteErr != nil {
			t.Fatal(unquoteErr)
		}
		if dependency == forbidden || strings.HasPrefix(dependency, forbidden+"/") {
			t.Errorf(
				"%s imports sibling implementation %s instead of its consumer-owned port",
				path,
				dependency,
			)
		}
	}
}
