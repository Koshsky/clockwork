package migration //nolint:testpackage // Test private compatibility helpers without expanding the production API.

import (
	"context"
	"crypto/rand"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	apperrors "github.com/Koshsky/erp-backend/internal/errors"
)

func testPool(t *testing.T, isolated bool) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("MIGRATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set MIGRATION_TEST_DATABASE_URL to a disposable local rehearsal database")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.ConnConfig.Database, "erp_migrator_") {
		t.Fatal("integration tests require an erp_migrator_ database")
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if !isolated {
		return pool
	}
	schema := "migration_test_" + strings.ToLower(rand.Text())
	name := pgx.Identifier{schema}.Sanitize()
	if _, err = pool.Exec(t.Context(), "CREATE SCHEMA "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, dropErr := pool.Exec(context.Background(), "DROP SCHEMA "+name+" CASCADE"); dropErr != nil {
			t.Error(dropErr)
		}
	})
	cfg, err = pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = name + ",public"
	scoped, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(scoped.Close)
	return scoped
}

func testLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

func historySnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var result string
	if err := pool.QueryRow(t.Context(), "SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY installed_rank), '[]')::text FROM flyway_schema_history h").
		Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestFlywayAdoption(t *testing.T) {
	t.Parallel()
	pool := testPool(t, false)
	before := historySnapshot(t, pool)
	data := coreDataSnapshot(t, pool)
	var coreCount int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM flyway_schema_history WHERE version IN ('1','2','3','4','5','6','7','8','9','10')").
		Scan(&coreCount); err != nil {
		t.Fatal(err)
	}
	if err := Run(t.Context(), pool, testLogger()); !errors.Is(err, apperrors.ErrMigrationValidation) {
		t.Fatalf("expected explicit adoption, got %v", err)
	}
	preview, err := AdoptFlyway(t.Context(), pool, true)
	if err != nil || preview.Baseline != coreCount {
		t.Fatalf("preview %v, %v", preview, err)
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != -1 {
		t.Fatalf("dry run wrote native history: %v %v", state, err)
	}
	report, err := AdoptFlyway(t.Context(), pool, false)
	if err != nil || report.Baseline != coreCount {
		t.Fatalf("adoption %v, %v", report, err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	state, err = Status(t.Context(), pool)
	if err != nil || state.Version != 14 || state.Dirty {
		t.Fatalf("state %v %v", state, err)
	}
	if got := historySnapshot(t, pool); got != before {
		t.Fatal("Flyway history changed")
	}
	if coreDataSnapshot(t, pool) != data {
		t.Fatal("existing data changed beyond responsible fields")
	}
	verifyFixture(t, pool, coreCount)
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	report, err = AdoptFlyway(t.Context(), pool, false)
	if err != nil || !report.AlreadyAdopted {
		t.Fatalf("repeat adoption %v %v", report, err)
	}
	state, err = Status(t.Context(), pool)
	if err != nil || state.Version != 14 {
		t.Fatalf("adoption rewound native version: %v %v", state, err)
	}
	if historySnapshot(t, pool) != before {
		t.Fatal("restart changed Flyway history")
	}
}

func TestFreshDatabase(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	if err := Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 14 || state.Dirty || state.Flyway {
		t.Fatalf("state %v %v", state, err)
	}
}

func TestDirtyMigrationRefusesStartup(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	if err := Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), "UPDATE schema_migrations SET dirty=true"); err != nil {
		t.Fatal(err)
	}
	if err := Run(t.Context(), pool, testLogger()); !errors.Is(err, apperrors.ErrMigrationExecution) {
		t.Fatalf("dirty history accepted: %v", err)
	}
}

func TestAdoptionRejectsInvalidHistory(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"checksum", "failed", "gap", "dirty"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			pool := testPool(t, true)
			if _, err := pool.Exec(
				t.Context(),
				"CREATE TABLE flyway_schema_history (LIKE public.flyway_schema_history INCLUDING ALL); INSERT INTO flyway_schema_history SELECT installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success FROM public.flyway_schema_history",
			); err != nil {
				t.Fatal(err)
			}
			query := map[string]string{
				"checksum": "UPDATE flyway_schema_history SET checksum=checksum+1 WHERE version='1'",
				"failed":   "UPDATE flyway_schema_history SET success=false WHERE version='1007'",
				"gap":      "DELETE FROM flyway_schema_history WHERE version='2'",
				"dirty":    "CREATE TABLE schema_migrations(version bigint PRIMARY KEY, dirty boolean); INSERT INTO schema_migrations VALUES (9,true)",
			}[scenario]
			if _, err := pool.Exec(t.Context(), query); err != nil {
				t.Fatal(err)
			}
			before := historySnapshot(t, pool)
			if _, err := AdoptFlyway(t.Context(), pool, false); !errors.Is(err, apperrors.ErrMigrationValidation) {
				t.Fatalf("invalid history accepted: %v", err)
			}
			if historySnapshot(t, pool) != before {
				t.Fatal("rejection changed Flyway history")
			}
		})
	}
}

func TestSQLFailureLeavesDirtyVersion(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	scripts, err := loadScripts([]fs.FS{fstest.MapFS{
		"V1__broken.sql": {Data: []byte("CREATE TABLE failed_step(id bigint); SELECT 1/0")},
	}})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := engineWithScripts(pool, scripts)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if closeErr := closeEngine(runner); closeErr != nil {
			t.Error(closeErr)
		}
	}()
	if err = runner.Up(); err == nil {
		t.Fatal("broken SQL succeeded")
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 1 || !state.Dirty {
		t.Fatalf("dirty state missing: %v %v", state, err)
	}
	var exists bool
	if err = pool.QueryRow(t.Context(), "SELECT to_regclass(format('%I.failed_step',current_schema())) IS NOT NULL").
		Scan(&exists); err != nil ||
		exists {
		t.Fatalf("failed SQL left DDL: %v %v", exists, err)
	}
}

func TestConcurrentStartup(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	var workers sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		workers.Go(func() { results <- Run(t.Context(), pool, testLogger()) })
	}
	workers.Wait()
	close(results)
	for result := range results {
		if result != nil {
			t.Fatal(result)
		}
	}
}

func TestAdoptionLockCancellation(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var schema string
	if err = tx.QueryRow(t.Context(), "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(
		t.Context(),
		"SELECT pg_advisory_xact_lock($1)",
		flywayLockID(pgx.Identifier{schema, historyName}.Sanitize()),
	); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if _, err = AdoptFlyway(ctx, pool, false); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cancellation: %v", err)
	}
}

func coreDataSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var result string
	const query = `SELECT jsonb_build_object(
		'users', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u),
		'projects', (SELECT jsonb_agg(to_jsonb(p) - 'responsible_id' ORDER BY id) FROM projects p),
		'processes', (SELECT jsonb_agg(to_jsonb(p) - 'responsible_id' ORDER BY id) FROM processes p),
		'tasks', (SELECT jsonb_agg(to_jsonb(t) - 'responsible_id' ORDER BY id) FROM tasks t),
		'resources', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM resources r),
		'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM assignments a)
	)::text`
	if err := pool.QueryRow(t.Context(), query).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func verifyFixture(t *testing.T, pool *pgxpool.Pool, coreCount int) {
	t.Helper()
	var err error
	var responsible *int64
	if err = pool.QueryRow(t.Context(), "SELECT responsible_id FROM tasks WHERE id=7501").
		Scan(&responsible); err != nil {
		t.Fatal(err)
	}
	if coreCount == 9 && (responsible == nil || *responsible != 4242) {
		t.Fatal("V10 backfill missing")
	}
	if coreCount == 10 && responsible != nil {
		t.Fatal("already applied V10 was replayed")
	}
	var marker string
	if err = pool.QueryRow(t.Context(), "SELECT marker || note FROM site_extension WHERE id=1").
		Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != "installed by Flywaypreserve across backend upgrade" {
		t.Fatal("plugin data changed")
	}
}
