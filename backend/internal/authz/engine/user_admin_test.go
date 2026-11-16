package engine_test

import (
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
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
		if got := engine.DefaultMatrix().ScopeFor("vp", access.ResourceUserAdmin, act); got != engine.ScopeNone {
			t.Errorf("ScopeFor(vp, user_admin, %v) = %v; want none", engine.ActionName(act), got)
		}
		if got := engine.DefaultMatrix().ScopeFor("admin", access.ResourceUserAdmin, act); got != engine.ScopeAll {
			t.Errorf("ScopeFor(admin, user_admin, %v) = %v; want all", engine.ActionName(act), got)
		}
		if engine.Authorize("vp", access.ResourceUserAdmin, act, access.Owners{}, 42) {
			t.Errorf("Authorize(vp, user_admin, %v) = true; want false", engine.ActionName(act))
		}
		if !engine.Authorize("admin", access.ResourceUserAdmin, act, access.Owners{}, 42) {
			t.Errorf("Authorize(admin, user_admin, %v) = false; want true", engine.ActionName(act))
		}
	}
}
