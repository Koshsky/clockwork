// Package authz wires the access-control domain: the Casbin engine
// (internal/authz/engine), the Postgres-backed policy store and the RBAC
// administration API. It merges the former internal/policies (rules in code)
// and internal/rbacpolicy (runtime policies from Postgres) packages.
package authz

import (
	"log/slog"

	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/authz/delivery"
	"github.com/Koshsky/erp-backend/internal/authz/repository"
	"github.com/Koshsky/erp-backend/internal/authz/service"
)

// ProviderSet aggregates the authz module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	repository.NewRuleRepository,
	service.NewPolicyStore,
	service.NewRBACService,
	service.NewOwnerProbe,
	delivery.NewRBACHandler,
	ProvideModule,
)

// Module registers the RBAC administration routes (all protected, admin-only).
type Module struct {
	handler *delivery.RBACHandler
	logger  *slog.Logger
}

// ProvideModule builds the authz module. OwnerProbe is consumed solely to
// trigger the engine probe registration at startup (sib/down scope moves).
func ProvideModule(handler *delivery.RBACHandler, logger *slog.Logger, _ *service.OwnerProbe) Module {
	return Module{handler: handler, logger: logger.With("component", "authz_module")}
}

// RegisterPublicRoutes is a no-op: the module has no public routes.
func (m Module) RegisterPublicRoutes(_ *gin.RouterGroup) {
}

// RegisterProtectedRoutes registers the admin routes behind authentication
// plus the own-permissions endpoint (any authenticated role, no admin gate).
func (m Module) RegisterProtectedRoutes(r *gin.RouterGroup) {
	m.handler.RegisterRoutes(r)
	r.GET("/permissions/me", m.handler.MyPermissions)
}
