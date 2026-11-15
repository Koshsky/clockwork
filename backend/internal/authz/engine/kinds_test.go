package engine_test

import (
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

// Codecs: roundtrip for each resource/action/scope + invalid values.
func TestResourceCodecs(t *testing.T) {
	t.Parallel()
	for i := access.ResourceProject; i <= access.ResourceRBACConfig; i++ {
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
	ownRes := map[access.Resource]bool{
		access.ResourceProject:      true,
		access.ResourceProcess:      false,
		access.ResourceTask:         false,
		access.ResourceMilestone:    false,
		access.ResourceAssignment:   false,
		access.ResourceState:        false,
		access.ResourceResource:     true,
		access.ResourceWorker:       true,
		access.ResourceComment:      false,
		access.ResourceUserCatalog:  false,
		access.ResourceRBACConfig:   false,
		access.ResourceUserAdmin:    false,
		access.ResourceStateAdmin:   false,
		access.ResourceOrgStructure: false,
		access.ResourceAudit:        false,
		access.ResourceAutoCreate:   false,
	}
	parentRes := map[access.Resource]bool{
		access.ResourceProject:      false,
		access.ResourceProcess:      true,
		access.ResourceTask:         true,
		access.ResourceMilestone:    true,
		access.ResourceAssignment:   true,
		access.ResourceState:        false,
		access.ResourceResource:     false,
		access.ResourceWorker:       false,
		access.ResourceComment:      false,
		access.ResourceUserCatalog:  false,
		access.ResourceRBACConfig:   false,
		access.ResourceUserAdmin:    false,
		access.ResourceStateAdmin:   false,
		access.ResourceOrgStructure: false,
		access.ResourceAudit:        false,
		access.ResourceAutoCreate:   false,
	}
	ancestorRes := map[access.Resource]bool{
		access.ResourceProject:      false,
		access.ResourceProcess:      true,
		access.ResourceTask:         true,
		access.ResourceMilestone:    true,
		access.ResourceAssignment:   true,
		access.ResourceState:        false,
		access.ResourceResource:     false,
		access.ResourceWorker:       false,
		access.ResourceComment:      false,
		access.ResourceUserCatalog:  false,
		access.ResourceRBACConfig:   false,
		access.ResourceUserAdmin:    false,
		access.ResourceStateAdmin:   false,
		access.ResourceOrgStructure: false,
		access.ResourceAudit:        false,
		access.ResourceAutoCreate:   false,
	}
	for i := access.ResourceProject; i <= access.ResourceRBACConfig; i++ {
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
		{Res: access.ResourceTask, Act: engine.ActionView, Role: "rp", Scope: engine.ScopeParent},
		{Res: access.ResourceTask, Act: engine.ActionView, Role: "rp", Scope: engine.ScopeAncestor},
	})
	if got := m.ScopeFor("rp", access.ResourceTask, engine.ActionView); got != engine.ScopeAncestor {
		t.Errorf("ScopeFor(rp, task, view) = %v; want ancestor (last wins)", got)
	}
	if got := m.ScopeFor("vp", access.ResourceTask, engine.ActionView); got != engine.ScopeNone {
		t.Errorf("ScopeFor(vp, task, view) = %v; want none", got)
	}
}

// DefaultMatrixRules ↔ NewMatrix equal the built-in matrix (the reset path loses
// no rule).
func TestDefaultMatrixRoundTrip(t *testing.T) {
	t.Parallel()
	rebuilt := engine.NewMatrix(engine.DefaultMatrixRules())
	roles := []string{"admin", "dp", "rp", "vp", "worker", "ghost"}
	for i := access.ResourceProject; i <= access.ResourceRBACConfig; i++ {
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
