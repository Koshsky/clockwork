// Package planning wires the planning module's providers and routes.
package planning

import (
	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/planning/delivery"
	"github.com/Koshsky/erp-backend/internal/planning/repository"
	"github.com/Koshsky/erp-backend/internal/planning/service"
)

// ProviderSet aggregates the planning module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	repository.NewPlanningRepository,
	service.NewPlanningService,
	delivery.NewPlanningHandler,
	ProvideModule,
)

// Module registers the planning module's routes (all protected).
type Module struct {
	handler *delivery.PlanningHandler
}

// ProvideModule builds the planning module.
func ProvideModule(handler *delivery.PlanningHandler) Module {
	return Module{handler: handler}
}

// RegisterPublicRoutes is a no-op: the planning module has no public routes.
func (m Module) RegisterPublicRoutes(_ *gin.RouterGroup) {
}

// RegisterProtectedRoutes registers the planning routes behind authentication.
func (m Module) RegisterProtectedRoutes(r *gin.RouterGroup) {
	m.handler.RegisterRoutes(r)
}
