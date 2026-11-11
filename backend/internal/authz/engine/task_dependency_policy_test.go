package engine_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

// DefaultRouteSpecs carry the task.dependency.* route policies (mirror V9):
// nested under /task/:id/dependencies(/:dep_id), the entity kind
// resolves the affected task by the :id path param — view via task.view,
// mutations via task.update.
func TestTaskDependencyRouteSpecs(t *testing.T) {
	t.Parallel()
	byName := make(map[string]engine.RouteSpec, len(engine.DefaultRouteSpecs()))
	for _, spec := range engine.DefaultRouteSpecs() {
		byName[spec.Name] = spec
	}
	for _, name := range []string{
		"task.dependency.list",
		"task.dependency.create",
		"task.dependency.update",
		"task.dependency.delete",
	} {
		spec, ok := byName[name]
		if !ok {
			t.Fatalf("DefaultRouteSpecs не содержит %s", name)
		}
		if err := engine.ValidateSpec(spec); err != nil {
			t.Errorf("ValidateSpec(%s) неожиданная ошибка: %v", name, err)
		}
	}
}
