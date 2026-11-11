// Package autocreate wires the auto-create config module's providers and routes.
package autocreate

import (
	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/auto_create/delivery"
	"github.com/Koshsky/erp-backend/internal/auto_create/repository"
	"github.com/Koshsky/erp-backend/internal/auto_create/service"
)

// ProviderSet aggregates the auto_create module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	repository.NewAutoCreateRepository,
	service.NewAutoCreateService,
	delivery.NewAutoCreateHandler,
	ProvideModule,
)

// Module registers the auto-create config routes (all protected, admin-only policies).
type Module struct {
	handler *delivery.AutoCreateHandler
}

// ProvideModule builds the auto_create module.
func ProvideModule(handler *delivery.AutoCreateHandler) Module {
	return Module{handler: handler}
}

// RegisterPublicRoutes is a no-op: the module has no public routes.
func (m Module) RegisterPublicRoutes(_ *gin.RouterGroup) {
}

// RegisterProtectedRoutes registers the module's routes behind authentication.
func (m Module) RegisterProtectedRoutes(r *gin.RouterGroup) {
	m.handler.RegisterRoutes(r)
}
