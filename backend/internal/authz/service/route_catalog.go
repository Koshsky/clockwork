package service

import "github.com/Koshsky/erp-backend/internal/authz/engine"

// RouteCatalog keeps HTTP rule construction outside policy administration.
type RouteCatalog interface {
	DefaultRouteSpecs() []engine.RouteSpec
	Kinds() []engine.KindInfo
	ValidateSpec(engine.RouteSpec) error
}
