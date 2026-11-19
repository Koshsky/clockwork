//nolint:testpackage // Exercise the actual readiness SQL only against an explicit isolated test database.
package server

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestReadinessPostgres(t *testing.T) {
	t.Parallel()
	dsn := os.Getenv("ERP_READINESS_TEST_DSN")
	if dsn == "" {
		t.Skip("explicit isolated PostgreSQL fixture required")
	}
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatal("fixture connection failed")
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(
		t.Context(),
		"CREATE TABLE schema_migrations(version bigint, dirty boolean NOT NULL)",
	); err != nil {
		t.Fatal("fixture setup failed")
	}
	for _, tc := range []struct {
		rows  string
		ready bool
	}{
		{"", false}, {"(14,false)", false}, {"(16,false)", false}, {"(15,true)", false},
		{"(15,false),(15,false)", false}, {"(15,false)", true},
	} {
		if _, err = pool.Exec(t.Context(), "TRUNCATE schema_migrations"); err != nil {
			t.Fatal("fixture reset failed")
		}
		if tc.rows != "" {
			if _, err = pool.Exec(t.Context(), "INSERT INTO schema_migrations VALUES "+tc.rows); err != nil {
				t.Fatal("fixture insert failed")
			}
		}
		if actual := newReadiness(pool).check(t.Context()); actual != tc.ready {
			t.Fatalf("schema state %s: got ready %v", tc.rows, actual)
		}
	}
	if _, err = pool.Exec(t.Context(), "DROP TABLE schema_migrations"); err != nil {
		t.Fatal("fixture cleanup failed")
	}
	if newReadiness(pool).check(t.Context()) {
		t.Fatal("missing schema reported readiness")
	}
	pool.Close()
	if newReadiness(pool).check(t.Context()) {
		t.Fatal("closed pool reported readiness")
	}
}
