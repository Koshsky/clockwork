package messages_test

// The catalog coverage gate: every user-facing message literal in the backend
// sources must have a catalog entry in the language it is NOT authored in, and
// every template id must be present in both catalogs. This keeps the catalogs
// complete whenever a developer adds or changes a message.

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Constructor names and message-argument indexes.
const (
	errorsPkg   = "github.com/Koshsky/erp-backend/pkg/errors"
	responsePkg = "github.com/Koshsky/erp-backend/internal/response"
	messagesPkg = "github.com/Koshsky/erp-backend/pkg/messages"

	// argFieldMessage is the message-argument index of errors.NewFieldError
	// (field, code, message).
	argFieldMessage = 2
	// argResponseMsg is the message-argument index of the response helpers
	// (c, code, msg) and response.InternalError (c, logger, msg, err).
	argResponseMsg = 2
	// argTemplateID is the template-id argument index of messages.M/Renderf.
	argTemplateID = 0
	// argFirst is the message-argument index of the remaining errors
	// constructors, which take the message as their only argument.
	argFirst = 0
)

// TestCatalogCoverage enforces the coverage rule described at the top of this
// file.
func TestCatalogCoverage(t *testing.T) {
	t.Parallel()

	ru, en := loadCatalogs(t)
	literals, templates := extractMessages(t, repoRoot(t))

	// skippedLiterals lists genuinely internal-only strings that are never
	// user-facing and therefore deliberately not in the catalogs.
	skippedLiterals := map[string]bool{
		// Logged only; the 500 body always renders the generic internal text.
		"audit query failed": true,
		// Logged only; the 500 body always renders the generic internal text.
		"idempotency commit failed": true,
		// Logged only; the 500 body always renders the generic internal text.
		"idempotency storage failure": true,
	}

	var missing []string
	for literal := range literals {
		if skippedLiterals[literal] {
			continue
		}
		if hasCyrillic(literal) {
			if _, ok := en[literal]; !ok {
				missing = append(missing, "catalog_en.json: "+literal)
			}
			continue
		}
		if _, ok := ru[literal]; !ok {
			missing = append(missing, "catalog_ru.json: "+literal)
		}
	}
	for id := range templates {
		if _, ok := ru[id]; !ok {
			missing = append(missing, "catalog_ru.json (template): "+id)
		}
		if _, ok := en[id]; !ok {
			missing = append(missing, "catalog_en.json (template): "+id)
		}
	}
	if len(missing) > 0 {
		t.Errorf("catalog entries missing for:\n  %s", strings.Join(missing, "\n  "))
	}
}

// loadCatalogs reads both catalog JSON files from the package directory.
func loadCatalogs(t *testing.T) (map[string]string, map[string]string) {
	t.Helper()
	return loadCatalog(t, "catalog_ru.json"), loadCatalog(t, "catalog_en.json")
}

// loadCatalog parses one catalog JSON file.
func loadCatalog(t *testing.T, name string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var entries map[string]string
	if err = json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return entries
}

// repoRoot returns the backend repository root relative to this package.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

// extractMessages walks the internal/ and pkg/ sources and collects the
// user-facing message literals (passed to error/response constructors) and the
// template ids (passed to messages.M/Renderf).
func extractMessages(t *testing.T, root string) (map[string]bool, map[string]bool) {
	t.Helper()
	literals := map[string]bool{}
	templates := map[string]bool{}

	errorSet := map[string]bool{
		"BadRequest": true, "NotFound": true, "Forbidden": true, "Conflict": true,
		"NewValidationError": true, "NewFieldError": true,
	}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "tmp" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if !strings.HasSuffix(rel, ".go") || strings.HasSuffix(rel, "_test.go") {
			return nil
		}
		if !strings.HasPrefix(rel, "internal/") && !strings.HasPrefix(rel, "pkg/") {
			return nil
		}
		collectFile(t, path, rel, literals, templates, errorSet)
		return nil
	})
	return literals, templates
}

// collectFile scans one Go source file for constructor calls carrying message
// literals or template ids.
func collectFile(
	t *testing.T,
	path, rel string,
	literals, templates map[string]bool,
	errorSet map[string]bool,
) {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", rel, err)
	}
	names := resolveImportNames(f)

	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		fun, isSelector := call.Fun.(*ast.SelectorExpr)
		if isSelector {
			recordSelectorCall(fun, names, call, literals, templates, errorSet)
			return true
		}
		// Same-package constructor calls inside pkg/errors itself.
		if ident, isIdent := call.Fun.(*ast.Ident); isIdent &&
			f.Name.Name == "errors" && errorSet[ident.Name] {
			recordLiteralArg(call, messageArgIndex(ident.Name, errorSet), literals)
		}
		return true
	})
}

// importNames is the struct of the local package names for the tracked
// imports, resolved per file (the errors package is aliased as errapi in
// files that also import the stdlib errors).
type importNames struct {
	errors, response, messages string
}

// resolveImportNames resolves the local import names of the tracked packages.
func resolveImportNames(f *ast.File) importNames {
	names := importNames{errors: "errors", response: "response", messages: "messages"}
	for _, imp := range f.Imports {
		p := strings.Trim(imp.Path.Value, `"`)
		name := p[strings.LastIndex(p, "/")+1:]
		if imp.Name != nil {
			name = imp.Name.Name
		}
		switch p {
		case errorsPkg:
			names.errors = name
		case responsePkg:
			names.response = name
		case messagesPkg:
			names.messages = name
		}
	}
	return names
}

// recordSelectorCall handles a pkg.Selector call of one of the tracked
// packages: message literals for error/response constructors, template ids
// for messages.M/Renderf.
func recordSelectorCall(
	fun *ast.SelectorExpr,
	names importNames,
	call *ast.CallExpr,
	literals, templates map[string]bool,
	errorSet map[string]bool,
) {
	pkgIdent, isIdent := fun.X.(*ast.Ident)
	if !isIdent {
		return
	}
	switch pkgIdent.Name {
	case names.errors:
		if arg := messageArgIndex(fun.Sel.Name, errorSet); arg >= 0 {
			recordLiteralArg(call, arg, literals)
		}
	case names.response:
		if arg := responseMessageArgIndex(fun.Sel.Name); arg >= 0 {
			recordLiteralArg(call, arg, literals)
		}
	case names.messages:
		if fun.Sel.Name == "M" || fun.Sel.Name == "Renderf" {
			recordLiteralArg(call, argTemplateID, templates)
		}
	}
}

// messageArgIndex returns the message-argument index of an errors constructor,
// or -1 when the name is not a tracked constructor.
func messageArgIndex(name string, set map[string]bool) int {
	if !set[name] {
		return -1
	}
	if name == "NewFieldError" {
		return argFieldMessage
	}
	return argFirst
}

// responseMessageArgIndex returns the message-argument index of a response
// helper, or -1 when the name is not tracked.
func responseMessageArgIndex(name string) int {
	switch name {
	case "BadRequest", "Unauthorized", "Forbidden", "NotFound", "TooManyRequests", "InternalError":
		return argResponseMsg
	default:
		return -1
	}
}

// recordLiteralArg records the string literal at the given argument index of a
// call into the target set (when the argument is a literal).
func recordLiteralArg(call *ast.CallExpr, idx int, target map[string]bool) {
	if idx < 0 || idx >= len(call.Args) {
		return
	}
	bl, ok := call.Args[idx].(*ast.BasicLit)
	if !ok || bl.Kind != token.STRING {
		return
	}
	v, err := strconv.Unquote(bl.Value)
	if err != nil {
		return
	}
	target[v] = true
}

// hasCyrillic reports whether the string contains Cyrillic letters — the
// authored-language marker used by the coverage rule.
func hasCyrillic(s string) bool {
	for _, r := range s {
		if r >= 0x0400 && r <= 0x04FF {
			return true
		}
	}
	return false
}
