package migration //nolint:testpackage // Rehearses the embedded transition with legacy custom roles.

import (
	"fmt"
	"io/fs"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/migrations"
)

func TestAdministrationUpgrade(t *testing.T) {
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
	if err = runner.Migrate(13); err != nil {
		t.Fatal(err)
	}
	if err = closeEngine(runner); err != nil {
		t.Fatal(err)
	}
	samples := seedAdministrationRoles(t, pool)
	_, err = pool.Exec(t.Context(), `
 INSERT INTO rbac_preset_rules(preset,resource,action,scope) VALUES
 ('worker','deployment_private','view','all'),('worker','state_admin','view','all'),
 ('worker','user_catalog','delete','all');
 INSERT INTO user_permissions(user_id,resource,action,scope,granted) VALUES
 (1,'state_admin','view','all',true),(1,'state','view','all',false);`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
	for _, item := range samples {
		t.Run(item.role, func(t *testing.T) {
			t.Parallel()
			assertAdministrationSample(t, pool, item)
		})
	}
	for _, query := range []string{
		`SELECT count(*) FROM rbac_preset_rules WHERE resource='deployment_private'`,
		`SELECT count(*) FROM rbac_preset_rules WHERE preset='worker' AND resource='state' AND action='view'`,
		`SELECT count(*) FROM user_permissions WHERE user_id=1 AND resource='state' AND action='view' AND NOT granted`,
		`SELECT count(*) FROM rbac_route_policies WHERE name='rbac.manage' AND params->>'action'='update'`,
		`SELECT count(*) FROM rbac_route_policies WHERE name='autocreate.update' AND params->>'resource'='auto_create'`,
		`SELECT count(*) FROM rbac_route_policies WHERE name='autocreate.list' AND kind='any_capability'`,
	} {
		var count int
		if err = pool.QueryRow(t.Context(), query).Scan(&count); err != nil || count != 1 {
			t.Errorf("preservation check: %s: %d, %v", query, count, err)
		}
	}
	var obsolete int
	if err = pool.QueryRow(t.Context(), `SELECT count(*) FROM rbac_preset_rules WHERE resource='state_admin' OR (resource='rbac_config' AND action<>'update') OR (resource='user_catalog' AND action<>'view')`).
		Scan(&obsolete); err != nil ||
		obsolete != 0 {
		t.Errorf("obsolete rights: %d, %v", obsolete, err)
	}
	if err = Run(t.Context(), pool, testLogger()); err != nil {
		t.Fatal(err)
	}
}

type administrationSample struct {
	role                         string
	id                           int
	view, update                 bool
	viewOverride, updateOverride int
}

func seedAdministrationRoles(t *testing.T, pool *pgxpool.Pool) []administrationSample {
	t.Helper()

	var samples []administrationSample
	for bits := range 4 {
		for view := -1; view <= 1; view++ {
			for update := -1; update <= 1; update++ {
				item := administrationSample{
					fmt.Sprintf("admin_transition_%d_%d_%d", bits, view+1, update+1),
					len(samples) + 1,
					bits&1 != 0,
					bits&2 != 0,
					view,
					update,
				}
				samples = append(samples, item)
				seedAdministrationSample(t, pool, item)
			}
		}
	}
	return samples
}

func assertAdministrationSample(t *testing.T, pool *pgxpool.Pool, item administrationSample) {
	t.Helper()
	for _, right := range []struct {
		resource, action string
		preset           bool
		override         int
	}{
		{"rbac_config", "update", item.view, item.viewOverride},
		{"auto_create", "view", item.view, item.viewOverride},
		{"auto_create", "update", item.update, item.updateOverride},
	} {
		var presetCount, userCount int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM rbac_preset_rules WHERE preset=$1 AND resource=$2 AND action=$3`, item.role, right.resource, right.action).
			Scan(&presetCount); err != nil {
			t.Fatal(err)
		}
		wantPreset := 0
		if right.preset {
			wantPreset = 1
		}
		if presetCount != wantPreset {
			t.Errorf("%s/%s preset count %d, want %d", right.resource, right.action, presetCount, wantPreset)
		}
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM user_permissions WHERE user_id=$1 AND resource=$2 AND action=$3 AND granted=$4`, item.id, right.resource, right.action, right.override == 1).
			Scan(&userCount); err != nil {
			t.Fatal(err)
		}
		wantUser := 0
		if right.override >= 0 {
			wantUser = 1
		}
		if userCount != wantUser {
			t.Errorf("%s/%s override count %d, want %d", right.resource, right.action, userCount, wantUser)
		}
	}
}

func seedAdministrationSample(t *testing.T, pool *pgxpool.Pool, item administrationSample) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `INSERT INTO rbac_presets(tag,name) VALUES($1,$1)`, item.role); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		t.Context(),
		`INSERT INTO users(id,username,first_name,last_name,password_hash,preset) VALUES($1,$2,'Test','Migration','test',$2)`,
		item.id,
		item.role,
	); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"view", "update"} {
		allowed := item.view
		override := item.viewOverride
		if action == "update" {
			allowed = item.update
			override = item.updateOverride
		}
		if allowed {
			if _, err := pool.Exec(
				t.Context(),
				`INSERT INTO rbac_preset_rules(preset,resource,action,scope) VALUES($1,'rbac_config',$2,'all')`,
				item.role,
				action,
			); err != nil {
				t.Fatal(err)
			}
		}
		if override >= 0 {
			if _, err := pool.Exec(
				t.Context(),
				`INSERT INTO user_permissions(user_id,resource,action,scope,granted) VALUES($1,'rbac_config',$2,'all',$3)`,
				item.id,
				action,
				override == 1,
			); err != nil {
				t.Fatal(err)
			}
		}
	}
}
