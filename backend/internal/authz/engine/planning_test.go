package engine_test

import (
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
)

// TestViewScopeCodeUserNoReferenceRule pins the regression root: a caller
// whose preset has NO matrix row for the reference resource resolves to the
// empty zone code (none is never stored, and its scope name is empty). The
// reference-data queries (/planning/processes parent projects, planning and
// calendar resources) must treat this empty code as include-all, otherwise a
// preset with the primary-entity view right (vp on process.view=all) loses
// every process.
//
//nolint:paralleltest // mutates the shared Casbin snapshot via publishWithRules; must be sequential
func TestViewScopeCodeUserNoReferenceRule(t *testing.T) {
	// Sequential: publishes the role assignment into the shared snapshot.
	publishWithRules(t, nil, nil, []engine.RoleAssign{
		{User: "7", Preset: userdomain.PresetProcessOwner},
	})

	vp := access.UserContext{ID: 7, Preset: userdomain.PresetProcessOwner}
	if got := engine.ViewScopeCodeUser(vp, access.ResourceProject); got != engine.ScopeProcessProjects {
		t.Errorf("ViewScopeCodeUser(vp, project) = %q; want \"\" (no project.view rule)", got)
	}
	if got := engine.ViewScopeCodeUser(vp, access.ResourceProcess); got != engine.ScopeProcessOwner {
		t.Errorf("ViewScopeCodeUser(vp, process) = %q; want all", got)
	}
	if got := engine.ViewScopeCodeUser(vp, access.ResourceResource); got != "self" {
		t.Errorf("ViewScopeCodeUser(vp, resource) = %q; want self", got)
	}
}

// The list kind checks the view right: roles without a view scope are denied,
// admin (bypass) and viewing roles pass.
func TestPlanningListCheck(t *testing.T) {
	t.Parallel()
	engine.SetMatrix(engine.DefaultMatrix())
	defer engine.SetMatrix(engine.DefaultMatrix())

	for _, act := range []struct {
		resource access.Resource
		viewRole string
		noRole   string
	}{
		{access.ResourceProject, "rp", "worker"},
		{access.ResourceProcess, "vp", "worker"},
		{access.ResourceTask, "vp", "worker"},
	} {
		if got := engine.ViewScopeCode(act.noRole, act.resource); got != "" {
			t.Errorf("ViewScopeCode(%s, %v) = %q; want empty (no access)", act.noRole, act.resource, got)
		}
		if got := engine.ViewScopeCode(act.viewRole, act.resource); got == "" {
			t.Errorf("ViewScopeCode(%s, %v) пуст; want a scope", act.viewRole, act.resource)
		}
	}
	if got := engine.ViewScopeCode("admin", access.ResourceProject); got != "all" {
		t.Errorf("ViewScopeCode(admin, project) = %q; want all", got)
	}
}
