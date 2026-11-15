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

	cmd := exec.CommandContext(t.Context(), "go", "list", "-deps", "-f", "{{.ImportPath}}",
		"./internal/authz/domain", "./internal/authz/engine", "./internal/tracing")
	cmd.Dir = "../.."
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("list core dependencies: %v\n%s", err, output)
	}
	for dependency := range strings.FieldsSeq(string(output)) {
		if strings.HasPrefix(dependency, "github.com/gin-gonic/") ||
			strings.HasPrefix(dependency, "github.com/Koshsky/erp-backend/internal/middleware/") ||
			dependency == "github.com/Koshsky/erp-backend/internal/userctx" ||
			(strings.HasPrefix(dependency, "github.com/Koshsky/erp-backend/internal/") &&
				strings.Contains(dependency, "/delivery")) {
			t.Errorf("neutral core depends on HTTP adapter %s", dependency)
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
		// B05 replaces the existing concrete publisher; B02 only moves data contracts.
		if dependency == "github.com/Koshsky/erp-backend/internal/middleware/rbac" &&
			name != "../authz/service/store.go" {
			t.Errorf("%s depends on HTTP-owned access contracts", name)
		}
	}
}
