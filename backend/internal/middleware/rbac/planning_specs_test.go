package rbac_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// DefaultRouteSpecs carry the planning.* route policies (mirror V9):
// /planning/* is gated by the view matrix of the underlying domain via the
// list kind (row scoping stays in the SQL).
func TestPlanningRouteSpecs(t *testing.T) {
	t.Parallel()
	byName := make(map[string]engine.RouteSpec, len(rbac.DefaultRouteSpecs()))
	for _, spec := range rbac.DefaultRouteSpecs() {
		byName[spec.Name] = spec
	}
	for _, name := range []string{"planning.projects", "planning.processes", "planning.tasks"} {
		spec, ok := byName[name]
		if !ok {
			t.Fatalf("DefaultRouteSpecs не содержит %s", name)
		}
		if err := rbac.ValidateSpec(spec); err != nil {
			t.Errorf("ValidateSpec(%s) неожиданная ошибка: %v", name, err)
		}
	}
}
