package rbac_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

func TestEveryDefaultRouteBuildsAnHTTPCheck(t *testing.T) {
	t.Parallel()
	specs := rbac.DefaultRouteSpecs()
	policies, err := rbac.BuildPolicies(specs)
	if err != nil || len(policies) != len(specs) {
		t.Fatalf("default checks: %d for %d specs, error=%v", len(policies), len(specs), err)
	}
	seen := make(map[string]bool, len(specs))
	for index, spec := range specs {
		if err = rbac.ValidateSpec(spec); err != nil {
			t.Fatalf("default definition %s: %v", spec.Name, err)
		}
		if policies[index].Name != spec.Name || policies[index].Check == nil || seen[spec.Name] {
			t.Fatalf("missing, reordered or duplicate HTTP policy: %s", spec.Name)
		}
		seen[spec.Name] = true
	}
}
