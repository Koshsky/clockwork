package rbac_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

const (
	admin  = "admin"
	dp     = "dp"
	rp     = "rp"
	vp     = "vp"
	worker = "worker"
	uAdmin = int64(1)
	uDP    = int64(2)
	uRP    = int64(3)
	uVP1   = int64(4)
	uVP2   = int64(5)
)

func publishWithRules(t *testing.T, grants []engine.RuleGrant, denies []engine.RuleDeny, roles []engine.RoleAssign) {
	t.Helper()
	t.Cleanup(func() {
		if restoreErr := engine.Publish(engine.DefaultPublishInput()); restoreErr != nil {
			t.Errorf("restore default snapshot: %v", restoreErr)
		}
	})
	input := engine.DefaultPublishInput()
	input.Grants = append(input.Grants, grants...)
	input.Denies = append(input.Denies, denies...)
	input.Roles = append(input.Roles, roles...)
	if err := engine.Publish(input); err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
}
