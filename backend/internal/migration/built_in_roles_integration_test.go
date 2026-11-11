package migration //nolint:testpackage // Rehearses the private embedded migration sequence.

import (
	"io/fs"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	authzengine "github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/migrations"
)

func TestBuiltInRolesUpgrade(t *testing.T) {
	t.Parallel()
	pool := testPool(t, true)
	scripts, err := loadScripts([]fs.FS{migrations.Files()})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := engineWithScripts(pool, scripts)
	if err != nil {
		t.Fatal(err)
	}
	if err = runner.Migrate(12); err != nil {
		t.Fatal(err)
	}
	if err = closeEngine(runner); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(t.Context(), `
 INSERT INTO rbac_presets(tag,name) VALUES('custom_role','Custom'),('renamed_vp','Renamed');
 INSERT INTO users(id,username,first_name,last_name,password_hash,preset)
 VALUES(1,'matrix_test','Matrix','Test','test','worker');
 INSERT INTO rbac_preset_rules(preset,resource,action,scope) VALUES
 ('custom_role','project','update','self'),('renamed_vp','task','view','all'),('worker','project','view','all');
 INSERT INTO user_permissions(user_id,resource,action,scope,granted) VALUES
 (1,'project','update','all',false),(1,'task','view','all',true);
 DELETE FROM rbac_presets WHERE tag='worker';`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	assertBuiltInDefaults(t, pool)
	for _, query := range []string{
		`SELECT COUNT(*) FROM rbac_presets WHERE tag='worker'`,
		`SELECT COUNT(*) FROM user_permissions WHERE user_id=1 AND action='prioritize' AND granted`,
	} {
		var count int
		if err = pool.QueryRow(t.Context(), query).Scan(&count); err != nil || count != 0 {
			t.Fatalf("unexpected row: %s (%d, %v)", query, count, err)
		}
	}
	for _, query := range []string{
		`SELECT COUNT(*) FROM rbac_preset_rules WHERE preset='custom_role' AND resource='project' AND action='update' AND scope='self'`,
		`SELECT COUNT(*) FROM rbac_preset_rules WHERE preset='custom_role' AND resource='project' AND action='prioritize' AND scope='self'`,
		`SELECT COUNT(*) FROM rbac_preset_rules WHERE preset='renamed_vp' AND resource='task' AND action='view' AND scope='all'`,
		`SELECT COUNT(*) FROM user_permissions WHERE user_id=1 AND resource='task' AND action='view' AND granted`,
		`SELECT COUNT(*) FROM user_permissions WHERE user_id=1 AND resource='project' AND action='prioritize' AND NOT granted`,
	} {
		var count int
		if err = pool.QueryRow(t.Context(), query).Scan(&count); err != nil || count != 1 {
			t.Fatalf("missing preserved rule: %s (%d, %v)", query, count, err)
		}
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
}

func assertBuiltInDefaults(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	rows, err := pool.Query(t.Context(), `
 SELECT preset,resource,action,scope FROM rbac_preset_rules WHERE preset IN ('dp','rp','vp','worker')`)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for rows.Next() {
		var role, res, act, scope string
		if err = rows.Scan(&role, &res, &act, &scope); err != nil {
			t.Fatal(err)
		}
		got[role+"/"+res+"/"+act] = scope
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	want := map[string]string{}
	for _, rule := range authzengine.DefaultMatrixRules() {
		if rule.Role != "worker" {
			want[rule.Role+"/"+authzengine.ResourceName(rule.Res)+"/"+authzengine.ActionName(rule.Act)] = rule.Scope
		}
	}
	if len(got) != len(want) {
		t.Fatalf("rules: got %d, want %d", len(got), len(want))
	}
	for key, scope := range want {
		if got[key] != scope {
			t.Errorf("%s=%s, want %s", key, got[key], scope)
		}
	}
}
