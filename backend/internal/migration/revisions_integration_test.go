package migration //nolint:testpackage // Rehearses additive revision migrations against real PostgreSQL schemas.

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func revisionMigrationBase(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := testPool(t, true)
	runner, err := engine(pool)
	if err != nil {
		t.Fatal(err)
	}
	if err = runner.Migrate(14); err != nil {
		t.Fatal(err)
	}
	if err = closeEngine(runner); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestRevisionUpgradePreservesReceiptsAndUnknownPlugin(t *testing.T) {
	t.Parallel()
	pool := revisionMigrationBase(t)
	_, err := pool.Exec(t.Context(), `
 CREATE TABLE unknown_revision_plugin(value text);
 INSERT INTO unknown_revision_plugin VALUES('unchanged');
 INSERT INTO users(id,last_name,first_name,username,password_hash) VALUES(1,'Fixture','Migration','fixture','unused');
 INSERT INTO projects(id,owner_id,code,start_date,end_date,priority) VALUES(1,1,'project','2026-11-01','2026-12-31',1);
 INSERT INTO processes(id,project_id,owner_id,title,start_date,end_date) VALUES(1,1,1,'process','2026-11-01','2026-12-31');
 INSERT INTO resources(id,owner_id,title,code) VALUES(1,1,'resource','code');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 15 || state.Dirty {
		t.Fatalf("revision upgrade: %+v %v", state, err)
	}
	_, err = pool.Exec(t.Context(), `
 INSERT INTO operation_receipts(user_id,operation_id,method,path,request_hash,response_status,response_body)
 VALUES(7,'accepted-after-upgrade','POST','/task','hash',201,'{"data":{"id":42}}');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	var marker string
	var receiptID, count int
	if err = pool.QueryRow(t.Context(), "SELECT value FROM unknown_revision_plugin").
		Scan(&marker); err != nil ||
		marker != "unchanged" {
		t.Fatal("plugin changed", err)
	}
	if err = pool.QueryRow(t.Context(), "SELECT (response_body->'data'->>'id')::int FROM operation_receipts WHERE operation_id='accepted-after-upgrade'").
		Scan(&receiptID); err != nil ||
		receiptID != 42 {
		t.Fatal("accepted receipt changed", err)
	}
	if err = pool.QueryRow(t.Context(), "SELECT count(*) FROM operation_revisions WHERE key IN ('project:1','process:1','resource:1','user_days:1','states')").
		Scan(&count); err != nil ||
		count != 5 {
		t.Fatal("existing records lack revisions", count, err)
	}
}

func TestRevisionNameCollisionPreservesUnknownPlugin(t *testing.T) {
	t.Parallel()
	pool := revisionMigrationBase(t)
	if _, err := pool.Exec(
		t.Context(),
		"CREATE TABLE operation_revisions(value text); INSERT INTO operation_revisions VALUES('plugin')",
	); err != nil {
		t.Fatal(err)
	}
	if err := Run(t.Context(), pool, testLogger()); err == nil {
		t.Fatal("incompatible plugin table was silently replaced")
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 15 || !state.Dirty {
		t.Fatalf("collision state: %+v %v", state, err)
	}
	var receiptsExist bool
	const receiptTableQuery = "SELECT to_regclass(format('%I.operation_receipts',current_schema())) IS NOT NULL"
	if err = pool.QueryRow(t.Context(), receiptTableQuery).Scan(&receiptsExist); err != nil || receiptsExist {
		t.Fatal("failed combined migration left its receipt table", err)
	}
	var marker string
	if err = pool.QueryRow(t.Context(), "SELECT value FROM operation_revisions").
		Scan(&marker); err != nil ||
		marker != "plugin" {
		t.Fatal("plugin changed", err)
	}
}

func TestCombinedOperationMigrationRejectsAheadVersion(t *testing.T) {
	t.Parallel()
	pool := revisionMigrationBase(t)
	if err := Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), "UPDATE schema_migrations SET version=16"); err != nil {
		t.Fatal(err)
	}
	if err := Run(t.Context(), pool, testLogger()); err == nil {
		t.Fatal("a database ahead of the embedded migrations was silently accepted")
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 16 || state.Dirty {
		t.Fatalf("ahead version was changed: %+v %v", state, err)
	}
}
