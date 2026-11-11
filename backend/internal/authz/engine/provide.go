package engine

import "github.com/Koshsky/erp-backend/internal/middleware/rbac"

// ProvideAll returns the default route checks — the initial middleware
// snapshot and the fallback when the DB is unavailable/empty. At runtime the
// real set is provided by the authz PolicyStore via rbac.Middleware.Refresh.
func ProvideAll() []rbac.Policy {
	policies, err := BuildPolicies(DefaultRouteSpecs())
	if err != nil {
		panic("engine: invalid default spec: " + err.Error())
	}
	return policies
}
