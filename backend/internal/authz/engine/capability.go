package engine

import (
	"fmt"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// buildAnyCapability is restricted to global capabilities: an ownerless check
// must never substitute for row-level authorization.
func buildAnyCapability(params map[string]any) (func(*rbac.CheckCtx) error, error) {
	permissions, err := strListParam(params, paramPermissions)
	if err != nil {
		return nil, err
	}
	if len(permissions) == 0 {
		return nil, fmt.Errorf("permissions must not be empty")
	}
	targets := make([]Target, 0, len(permissions))
	for _, permission := range permissions {
		res, act, parseErr := splitKey(permission)
		if parseErr != nil {
			return nil, fmt.Errorf("invalid global capability: %w", parseErr)
		}
		if nodeHasOwner[res] || nodeHasParent[res] {
			return nil, fmt.Errorf("capability %q requires row-level authorization", permission)
		}
		targets = append(targets, Target{Res: res, Act: act})
	}
	return func(rc *rbac.CheckCtx) error {
		for _, target := range targets {
			target.Ctx = rc.C.Request.Context()
			if EnforceTarget(rc.User, target) {
				return nil
			}
		}
		return errors.ErrForbidden
	}, nil
}
