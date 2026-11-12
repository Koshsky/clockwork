package migration //nolint:testpackage // Rehearses the additive V14 to V15 transition on an isolated schema.

import (
	"testing"
)

func TestDurableReceiptsUpgradePreservesExistingKeysAndPlugins(t *testing.T) {
	t.Parallel()
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
	_, err = pool.Exec(t.Context(), `
INSERT INTO idempotency_keys(key,user_id,method,path,response_status,response_body,expires_at)
VALUES ('before-durable',7,'POST','/task',201,'{"data":{"id":42}}',now()+interval '1 day');
CREATE TABLE custom_plugin_marker(value text);
INSERT INTO custom_plugin_marker VALUES ('preserve me');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 15 || state.Dirty {
		t.Fatalf("upgrade state: %+v, %v", state, err)
	}
	var legacyID, count int
	var marker string
	if err = pool.QueryRow(t.Context(), "SELECT (response_body->'data'->>'id')::int FROM idempotency_keys WHERE key='before-durable'").
		Scan(&legacyID); err != nil ||
		legacyID != 42 {
		t.Fatal("legacy key changed", legacyID, err)
	}
	if err = pool.QueryRow(t.Context(), "SELECT value FROM custom_plugin_marker").
		Scan(&marker); err != nil ||
		marker != "preserve me" {
		t.Fatal("plugin changed", marker, err)
	}
	if err = pool.QueryRow(t.Context(), "SELECT count(*) FROM operation_receipts").
		Scan(&count); err != nil ||
		count != 0 {
		t.Fatal("unexpected receipt adoption", count, err)
	}
}

func TestDurableReceiptNameCollisionPreservesPluginData(t *testing.T) {
	t.Parallel()
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
	_, err = pool.Exec(
		t.Context(),
		"CREATE TABLE operation_receipts(value text); INSERT INTO operation_receipts VALUES('plugin data')",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err == nil {
		t.Fatal("incompatible plugin table was silently adopted")
	}
	state, err := Status(t.Context(), pool)
	if err != nil || state.Version != 15 || !state.Dirty {
		t.Fatalf("collision state: %+v, %v", state, err)
	}
	var value string
	if err = pool.QueryRow(t.Context(), "SELECT value FROM operation_receipts").
		Scan(&value); err != nil ||
		value != "plugin data" {
		t.Fatal("plugin data was overwritten", value, err)
	}
}
