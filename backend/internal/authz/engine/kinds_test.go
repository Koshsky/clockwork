package engine_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// Codecs: roundtrip for each resource/action/scope + invalid values.
func TestResourceCodecs(t *testing.T) {
	t.Parallel()
	for i := rbac.ResourceProject; i <= rbac.ResourceRBACConfig; i++ {
		name := engine.ResourceName(i)
		if name == "" {
			t.Fatalf("ResourceName(%v) пуст", i)
		}
		back, ok := engine.ParseResource(name)
		if !ok || back != i {
			t.Errorf("ParseResource(%q) = %v, %v; want %v", name, back, ok, i)
		}
	}
	for _, bogus := range []string{"bogus", "review", "Organization"} {
		if _, ok := engine.ParseResource(bogus); ok {
			t.Errorf("ParseResource(%q) должен быть false", bogus)
		}
	}
}

func TestActionCodecs(t *testing.T) {
	t.Parallel()
	for i := engine.ActionView; i <= engine.ActionDelete; i++ {
		name := engine.ActionName(i)
		back, ok := engine.ParseAction(name)
		if !ok || back != i {
			t.Errorf("ParseAction(%q) = %v, %v; want %v", name, back, ok, i)
		}
	}
	if _, ok := engine.ParseAction("edit"); ok {
		t.Errorf(`ParseAction("edit") должен быть false`)
	}
}

func TestScopeCodecs(t *testing.T) {
	t.Parallel()
	for _, scope := range []string{engine.ScopeAll, engine.ScopeOwn, engine.ScopeParent, engine.ScopeAncestor} {
		back, ok := engine.ParseScope(scope)
		if !ok || back != scope {
			t.Errorf("ParseScope(%q) = %q, %v; want %q", scope, back, ok, scope)
		}
	}
	if scope, ok := engine.ParseScope(""); !ok || scope != engine.ScopeNone {
		t.Errorf("ParseScope(\"\") = %q, %v; want none", scope, ok)
	}
	if _, ok := engine.ParseScope("bogus"); ok {
		t.Errorf(`ParseScope("bogus") должен быть false`)
	}
}

// Exact scope applicability table per resource (mirrors the backend ScopeApplicable).
func TestScopeApplicableTable(t *testing.T) {
	t.Parallel()
	ownRes := map[rbac.Resource]bool{
		rbac.ResourceProject:      true,
		rbac.ResourceProcess:      false,
		rbac.ResourceTask:         false,
		rbac.ResourceMilestone:    false,
		rbac.ResourceAssignment:   false,
		rbac.ResourceState:        false,
		rbac.ResourceResource:     true,
		rbac.ResourceWorker:       true,
		rbac.ResourceComment:      false,
		rbac.ResourceUserCatalog:  false,
		rbac.ResourceRBACConfig:   false,
		rbac.ResourceUserAdmin:    false,
		rbac.ResourceStateAdmin:   false,
		rbac.ResourceOrgStructure: false,
		rbac.ResourceAudit:        false,
		rbac.ResourceAutoCreate:   false,
	}
	parentRes := map[rbac.Resource]bool{
		rbac.ResourceProject:      false,
		rbac.ResourceProcess:      true,
		rbac.ResourceTask:         true,
		rbac.ResourceMilestone:    true,
		rbac.ResourceAssignment:   true,
		rbac.ResourceState:        false,
		rbac.ResourceResource:     false,
		rbac.ResourceWorker:       false,
		rbac.ResourceComment:      false,
		rbac.ResourceUserCatalog:  false,
		rbac.ResourceRBACConfig:   false,
		rbac.ResourceUserAdmin:    false,
		rbac.ResourceStateAdmin:   false,
		rbac.ResourceOrgStructure: false,
		rbac.ResourceAudit:        false,
		rbac.ResourceAutoCreate:   false,
	}
	ancestorRes := map[rbac.Resource]bool{
		rbac.ResourceProject:      false,
		rbac.ResourceProcess:      true,
		rbac.ResourceTask:         true,
		rbac.ResourceMilestone:    true,
		rbac.ResourceAssignment:   true,
		rbac.ResourceState:        false,
		rbac.ResourceResource:     false,
		rbac.ResourceWorker:       false,
		rbac.ResourceComment:      false,
		rbac.ResourceUserCatalog:  false,
		rbac.ResourceRBACConfig:   false,
		rbac.ResourceUserAdmin:    false,
		rbac.ResourceStateAdmin:   false,
		rbac.ResourceOrgStructure: false,
		rbac.ResourceAudit:        false,
		rbac.ResourceAutoCreate:   false,
	}
	for i := rbac.ResourceProject; i <= rbac.ResourceRBACConfig; i++ {
		if !engine.ScopeApplicable(i, engine.ScopeAll) {
			t.Errorf("ScopeApplicable(%v, all) = false; want true", i)
		}
		if engine.ScopeApplicable(i, engine.ScopeNone) {
			t.Errorf("ScopeApplicable(%v, none) = true; want false", i)
		}
		wantOwn := ownRes[i]
		if got := engine.ScopeApplicable(i, engine.ScopeOwn); got != wantOwn {
			t.Errorf("ScopeApplicable(%v, own) = %v; want %v", i, got, wantOwn)
		}
		wantParent := parentRes[i]
		if got := engine.ScopeApplicable(i, engine.ScopeParent); got != wantParent {
			t.Errorf("ScopeApplicable(%v, parent) = %v; want %v", i, got, wantParent)
		}
		wantAncestor := ancestorRes[i]
		if got := engine.ScopeApplicable(i, engine.ScopeAncestor); got != wantAncestor {
			t.Errorf("ScopeApplicable(%v, ancestor) = %v; want %v", i, got, wantAncestor)
		}
	}
}

// NewMatrix: the last (role, resource, action) pair wins.
func TestNewMatrixLastWins(t *testing.T) {
	t.Parallel()
	m := engine.NewMatrix([]engine.MatrixRule{
		{Res: rbac.ResourceTask, Act: engine.ActionView, Role: "rp", Scope: engine.ScopeParent},
		{Res: rbac.ResourceTask, Act: engine.ActionView, Role: "rp", Scope: engine.ScopeAncestor},
	})
	if got := m.ScopeFor("rp", rbac.ResourceTask, engine.ActionView); got != engine.ScopeAncestor {
		t.Errorf("ScopeFor(rp, task, view) = %v; want ancestor (last wins)", got)
	}
	if got := m.ScopeFor("vp", rbac.ResourceTask, engine.ActionView); got != engine.ScopeNone {
		t.Errorf("ScopeFor(vp, task, view) = %v; want none", got)
	}
}

// DefaultMatrixRules ↔ NewMatrix equal the built-in matrix (the reset path loses
// no rule).
func TestDefaultMatrixRoundTrip(t *testing.T) {
	t.Parallel()
	rebuilt := engine.NewMatrix(engine.DefaultMatrixRules())
	roles := []string{"admin", "dp", "rp", "vp", "worker", "ghost"}
	for i := rbac.ResourceProject; i <= rbac.ResourceRBACConfig; i++ {
		for act := engine.ActionView; act <= engine.ActionDelete; act++ {
			for _, role := range roles {
				want := engine.DefaultMatrix().ScopeFor(role, i, act)
				if got := rebuilt.ScopeFor(role, i, act); got != want {
					t.Errorf("roundtrip mismatch role=%s res=%v act=%v: got %v want %v", role, i, act, got, want)
				}
			}
		}
	}
}

// Kind validation: valid ones are built, invalid ones are an error.
func TestValidateSpec(t *testing.T) {
	t.Parallel()
	valid := []engine.RouteSpec{
		{Name: "b.list", Kind: "list", Params: map[string]any{"resource": "project", "query_key": "owner_id"}},
		{
			Name:   "b.view",
			Kind:   "entity",
			Params: map[string]any{"resource": "project", "action": "view", "owner": "id"},
		},
		{
			Name:   "b.view.none",
			Kind:   "entity",
			Params: map[string]any{"resource": "state", "action": "view", "owner": "none"},
		},
		{
			Name:   "b.create",
			Kind:   "create",
			Params: map[string]any{"resource": "task", "parent_resource": "process", "parent_from": "process_id"},
		},
		{
			Name:   "b.create.self",
			Kind:   "create",
			Params: map[string]any{"resource": "worker", "owner_key": "manager_id", "default_self": true},
		},
		{Name: "b.owner.match", Kind: "owner_match", Params: map[string]any{
			"resource": "assignment", "primary_resource": "task", "primary_from": "task_id",
			"compare_resource": "resource", "compare_from": "resource_id", "exempt_roles": []any{"admin"},
		}},
		{Name: "b.author.or", Kind: "author_or", Params: map[string]any{
			"author_resource": "comment", "author_id_param": "comment_id",
			"right_resource": "task", "right_action": "update",
		}},
		{
			Name: "b.task.order",
			Kind: "parent_action",
			Params: map[string]any{
				"resource":        "task",
				"action":          "update",
				"parent_resource": "process",
				"parent_from":     "process_id",
			},
		},
		{
			Name: "b.process.order",
			Kind: "parent_action",
			Params: map[string]any{
				"resource":        "process",
				"action":          "update",
				"parent_resource": "project",
				"parent_from":     "project_id",
			},
		},
	}
	for _, spec := range valid {
		if err := engine.ValidateSpec(spec); err != nil {
			t.Errorf("ValidateSpec(%s) неожиданная ошибка: %v", spec.Name, err)
		}
	}

	invalid := []struct {
		name string
		spec engine.RouteSpec
	}{
		{"unknown kind", engine.RouteSpec{Name: "x", Kind: "wat", Params: map[string]any{}}},
		{
			"unknown resource",
			engine.RouteSpec{Name: "x", Kind: "entity", Params: map[string]any{"resource": "nope", "action": "view"}},
		},
		{
			"unknown action",
			engine.RouteSpec{
				Name:   "x",
				Kind:   "entity",
				Params: map[string]any{"resource": "project", "action": "edit"},
			},
		},
		{
			"list без query_key",
			engine.RouteSpec{Name: "x", Kind: "list", Params: map[string]any{"resource": "project"}},
		},
		{
			"create: parent_from без parent_resource",
			engine.RouteSpec{
				Name:   "x",
				Kind:   "create",
				Params: map[string]any{"resource": "task", "parent_from": "process_id"},
			},
		},
		{
			"create: ни parent_from ни owner_key",
			engine.RouteSpec{Name: "x", Kind: "create", Params: map[string]any{"resource": "task"}},
		},
		{"owner_match: неизвестный compare", engine.RouteSpec{Name: "x", Kind: "owner_match", Params: map[string]any{
			"resource": "assignment", "primary_resource": "task", "primary_from": "task_id",
			"compare_resource": "nope", "compare_from": "resource_id",
		}}},
		{"author_or: неизвестное право", engine.RouteSpec{Name: "x", Kind: "author_or", Params: map[string]any{
			"author_resource": "comment", "author_id_param": "comment_id",
			"right_resource": "task", "right_action": "edit",
		}}},
		{
			"parent_action: parent_from без parent_resource",
			engine.RouteSpec{Name: "x", Kind: "parent_action", Params: map[string]any{
				"resource": "task", "action": "update", "parent_from": "process_id",
			}},
		},
		{
			"parent_action: неизвестный родитель",
			engine.RouteSpec{Name: "x", Kind: "parent_action", Params: map[string]any{
				"resource": "task", "action": "update", "parent_resource": "nope", "parent_from": "process_id",
			}},
		},
		{
			"parent_action: неизвестное действие",
			engine.RouteSpec{Name: "x", Kind: "parent_action", Params: map[string]any{
				"resource": "task", "action": "edit", "parent_resource": "process", "parent_from": "process_id",
			}},
		},
		{
			"имя с пробелами",
			engine.RouteSpec{
				Name:   " x ",
				Kind:   "entity",
				Params: map[string]any{"resource": "project", "action": "view"},
			},
		},
		{
			"пустое имя",
			engine.RouteSpec{
				Name:   "",
				Kind:   "entity",
				Params: map[string]any{"resource": "project", "action": "view"},
			},
		},
		{
			"неверный тип параметра",
			engine.RouteSpec{
				Name:   "x",
				Kind:   "create",
				Params: map[string]any{"resource": 42, "owner_key": "owner_id"},
			},
		},
	}
	for _, tc := range invalid {
		if err := engine.ValidateSpec(tc.spec); err == nil {
			t.Errorf("ValidateSpec(%s) должен дать ошибку", tc.name)
		}
	}

	// BuildPolicies: an invalid specification fails the whole build (fail-closed).
	built, err := engine.BuildPolicies([]engine.RouteSpec{valid[0], invalid[1].spec})
	if err == nil || len(built) != 0 {
		t.Errorf("BuildPolicies с битой спецификацией: err=%v built=%d; want error и пусто", err, len(built))
	}
}

// The Kinds reference contains all kinds and parameter schemas.
func TestKinds(t *testing.T) {
	t.Parallel()
	infos := engine.Kinds()
	if len(infos) != 7 {
		t.Fatalf("Kinds() = %d; want 7", len(infos))
	}
	seen := map[string]bool{}
	for _, k := range infos {
		seen[k.Name] = true
		if len(k.Params) == 0 {
			t.Errorf("kind %s без схемы параметров", k.Name)
		}
	}
	for _, name := range []string{"list", "entity", "create", "owner_match", "author_or", "parent_action", "any_capability"} {
		if !seen[name] {
			t.Errorf("в Kinds() нет kind'а %s", name)
		}
	}
}
