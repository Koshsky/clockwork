package rbac

import "github.com/Koshsky/erp-backend/internal/authz/engine"

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
