package migration //nolint:testpackage // reuses the existing disposable-database fixture.

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/internal/logger"
)

func TestMigrationDiagnosticsPreserveOutcomesAndRelease(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	var output bytes.Buffer
	log := logger.Bootstrap("1.6.0", &output)
	if err := Run(t.Context(), pool, log); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), "UPDATE schema_migrations SET dirty=true"); err != nil {
		t.Fatal(err)
	}
	if err := Run(t.Context(), pool, log); !errors.Is(err, apperrors.ErrMigrationExecution) {
		t.Fatal("diagnostics changed failed migration semantics")
	}
	text := output.String()
	decoder := json.NewDecoder(strings.NewReader(text))
	for _, expected := range []string{"checking database migrations", "golang-migrate schema ready", "checking database migrations", "migration check failed"} {
		var event map[string]any
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event["msg"] != expected || event["version"] != "1.6.0" || event["component"] != "migration" {
			t.Fatalf("migration outcome missing context: %v", event)
		}
		if expected == "migration check failed" &&
			(event["level"] != "ERROR" || event["error_code"] != "MIGRATION_EXECUTION") {
			t.Fatalf("failed migration lost its classification: %v", event)
		}
	}
	if strings.Contains(text, "password") || strings.Contains(text, "UPDATE schema_migrations") {
		t.Fatal("migration diagnostics exposed a connection setting")
	}
}
