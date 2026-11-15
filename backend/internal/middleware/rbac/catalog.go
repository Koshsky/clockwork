package rbac

import "github.com/Koshsky/erp-backend/internal/authz/engine"

// PrepareRoutes validates before publication so a failed reload keeps live checks.
func (m *Middleware) PrepareRoutes(specs []engine.RouteSpec) (func(), error) {
	policies, err := BuildPolicies(specs)
	if err != nil {
		return nil, err
	}
	return func() { m.Refresh(policies) }, nil
}

// DefaultRouteSpecs supplies the reset catalog through the HTTP adapter.
func (*Middleware) DefaultRouteSpecs() []engine.RouteSpec {
	return DefaultRouteSpecs()
}

// Kinds preserves the public parameter catalog without coupling services to builders.
func (*Middleware) Kinds() []engine.KindInfo {
	return Kinds()
}

// ValidateSpec checks a stored definition using the same builder as runtime loading.
func (*Middleware) ValidateSpec(spec engine.RouteSpec) error {
	return ValidateSpec(spec)
}
