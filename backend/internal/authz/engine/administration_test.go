package engine_test

import (
	"slices"
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

func TestAdministrationActionCatalog(t *testing.T) {
	t.Parallel()
	for name, actions := range map[string][]engine.Action{
		"rbac_config":   {engine.ActionUpdate},
		"auto_create":   {engine.ActionView, engine.ActionUpdate},
		"user_catalog":  {engine.ActionView},
		"org_structure": {engine.ActionView},
		"audit":         {engine.ActionView},
		"state_admin":   {},
	} {
		resource, _ := engine.ParseResource(name)
		for action := engine.ActionView; action <= engine.ActionPrioritize; action++ {
			if got := engine.ActionApplicable(resource, action); got != slices.Contains(actions, action) {
				t.Errorf("%s/%s applicability %v", engine.ResourceName(resource), engine.ActionName(action), got)
			}
		}
	}
}
