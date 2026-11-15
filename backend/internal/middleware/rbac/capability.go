package rbac

import (
	"fmt"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// buildAnyCapability is restricted to global capabilities: an ownerless check
// must never substitute for row-level authorization.
func buildAnyCapability(params map[string]any) (func(*CheckCtx) error, error) {
	permissions, err := strListParam(params, paramPermissions)
	if err != nil {
		return nil, err
	}
	if len(permissions) == 0 {
		return nil, fmt.Errorf("permissions must not be empty")
	}
	targets := make([]engine.Target, 0, len(permissions))
	for _, permission := range permissions {
		res, act, parseErr := engine.ParsePermissionKey(permission)
		if parseErr != nil {
			return nil, fmt.Errorf("invalid global capability: %w", parseErr)
		}
		if engine.ResourceRequiresOwners(res) {
			return nil, fmt.Errorf("capability %q requires row-level authorization", permission)
		}
		targets = append(targets, engine.Target{Res: res, Act: act})
	}
	return func(rc *CheckCtx) error {
		for _, target := range targets {
			target.Ctx = rc.C.Request.Context()
			if engine.EnforceTarget(rc.User, target) {
				return nil
			}
		}
		return errors.ErrForbidden
	}, nil
}
