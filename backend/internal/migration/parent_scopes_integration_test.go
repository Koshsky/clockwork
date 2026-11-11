package migration //nolint:testpackage // Exercises private migration helpers in an isolated schema.

import (
	"io/fs"
	"testing"

	"github.com/Koshsky/erp-backend/migrations"
)

func TestParentScopesUpgrade(t *testing.T) {
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
	if err = runner.Migrate(11); err != nil {
		t.Fatal(err)
	}
	if err = closeEngine(runner); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(t.Context(), `
 INSERT INTO rbac_presets(tag,name) VALUES('parent_scope_test','Parent scope test');
 INSERT INTO users(id,username,first_name,last_name,password_hash,preset)
 VALUES(1,'parent_scope_test','Parent','Test','test','worker');
 INSERT INTO rbac_preset_rules(preset,resource,action,scope) VALUES
 ('parent_scope_test','process','view','self'),
 ('parent_scope_test','process','create','own'),
 ('parent_scope_test','task','view','self up1'),
 ('parent_scope_test','task','update','self sib'),
 ('parent_scope_test','task','delete','all'),
 ('parent_scope_test','project','view','own'),
 ('parent_scope_test','resource','view','self');
 INSERT INTO user_permissions(user_id,resource,action,scope,granted) VALUES
 (1,'task','view','self',true),
 (1,'process','update','own',true),
 (1,'task','delete','self',false),
 (1,'resource','view','self',true);`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	var got string
	err = pool.QueryRow(t.Context(), `SELECT string_agg(resource||'/'||action||'='||scope, ',' ORDER BY resource,action)
 FROM rbac_preset_rules WHERE preset='parent_scope_test'`).Scan(&got)
	want := "process/create=up1,process/view=up1,project/view=own,resource/view=self,task/delete=all,task/update=up1 sib,task/view=up1 up1"
	if err != nil || got != want {
		t.Fatalf("preset scopes %q, want %q: %v", got, want, err)
	}
	err = pool.QueryRow(t.Context(), `SELECT string_agg(resource||'/'||action||'='||scope||':'||granted, ',' ORDER BY resource,action)
 FROM user_permissions WHERE user_id=1`).
		Scan(&got)
	want = "process/update=up1:true,resource/view=self:true,task/delete=up1:false,task/view=up1:true"
	if err != nil || got != want {
		t.Fatalf("user scopes %q, want %q: %v", got, want, err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
}
