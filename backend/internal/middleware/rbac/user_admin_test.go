package rbac_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// DefaultRouteSpecs carry the user_admin.* route policies (mirror V9)
// and they are valid (nullable owner — the virtual resource has no owner).
func TestUserAdminRouteSpecs(t *testing.T) {
	t.Parallel()
	byName := make(map[string]engine.RouteSpec, len(rbac.DefaultRouteSpecs()))
	for _, spec := range rbac.DefaultRouteSpecs() {
		byName[spec.Name] = spec
	}
	for _, name := range []string{"user_admin.create", "user_admin.update", "user_admin.delete"} {
		spec, ok := byName[name]
		if !ok {
			t.Fatalf("DefaultRouteSpecs не содержит %s", name)
		}
		if err := rbac.ValidateSpec(spec); err != nil {
			t.Errorf("ValidateSpec(%s) неожиданная ошибка: %v", name, err)
		}
	}
}
