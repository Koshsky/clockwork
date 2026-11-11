package engine_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// The user-edit right (user_admin.*): an employee IS a system user, so profile
// mutations are gated by the user_admin virtual resource. The default matrix
// grants it to nobody but admin (the bypass); it stays grantable via the
// matrix (scope "all" is the only applicable one).
func TestUserAdminRights(t *testing.T) {
	t.Parallel()
	for _, act := range []engine.Action{
		engine.ActionCreate, engine.ActionUpdate, engine.ActionDelete,
	} {
		if got := engine.DefaultMatrix().ScopeFor("vp", rbac.ResourceUserAdmin, act); got != engine.ScopeNone {
			t.Errorf("ScopeFor(vp, user_admin, %v) = %v; want none", engine.ActionName(act), got)
		}
		if got := engine.DefaultMatrix().ScopeFor("admin", rbac.ResourceUserAdmin, act); got != engine.ScopeAll {
			t.Errorf("ScopeFor(admin, user_admin, %v) = %v; want all", engine.ActionName(act), got)
		}
		if engine.Authorize("vp", rbac.ResourceUserAdmin, act, rbac.Owners{}, 42) {
			t.Errorf("Authorize(vp, user_admin, %v) = true; want false", engine.ActionName(act))
		}
		if !engine.Authorize("admin", rbac.ResourceUserAdmin, act, rbac.Owners{}, 42) {
			t.Errorf("Authorize(admin, user_admin, %v) = false; want true", engine.ActionName(act))
		}
	}
}

// DefaultRouteSpecs carry the user_admin.* route policies (mirror V9)
// and they are valid (nullable owner — the virtual resource has no owner).
func TestUserAdminRouteSpecs(t *testing.T) {
	t.Parallel()
	byName := make(map[string]engine.RouteSpec, len(engine.DefaultRouteSpecs()))
	for _, spec := range engine.DefaultRouteSpecs() {
		byName[spec.Name] = spec
	}
	for _, name := range []string{"user_admin.create", "user_admin.update", "user_admin.delete"} {
		spec, ok := byName[name]
		if !ok {
			t.Fatalf("DefaultRouteSpecs не содержит %s", name)
		}
		if err := engine.ValidateSpec(spec); err != nil {
			t.Errorf("ValidateSpec(%s) неожиданная ошибка: %v", name, err)
		}
	}
}
