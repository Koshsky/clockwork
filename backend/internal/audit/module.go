// Package audit wires the audit module's providers and routes. The middleware
// (capturing mutations) is mounted by the server on the public and protected
// groups; the module itself only registers the admin read API.
package audit

import (
	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/audit/delivery"
	"github.com/Koshsky/erp-backend/internal/config"
)

// ProviderSet aggregates the audit module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	NewClient,
	NewSender,
	NewMiddleware,
	delivery.NewAuditHandler,
	ProvideModule,
	// The delivery handler consumes the query interface; the concrete client
	// implements it (plain types, no import cycle).
	wire.Bind(new(delivery.AuditQueryService), new(*Client)),
)

// Module registers the audit module's protected routes (admin read API).
type Module struct {
	handler *delivery.AuditHandler
	cfg     config.AuditConfig
}

// ProvideModule builds the audit module.
func ProvideModule(handler *delivery.AuditHandler, cfg config.AuditConfig) Module {
	return Module{handler: handler, cfg: cfg}
}

// RegisterPublicRoutes is a no-op: the audit module has no public routes.
func (m Module) RegisterPublicRoutes(_ *gin.RouterGroup) {
}

// RegisterProtectedRoutes registers the admin audit routes when enabled.
func (m Module) RegisterProtectedRoutes(r *gin.RouterGroup) {
	if m.cfg.Enabled {
		m.handler.RegisterRoutes(r)
	}
}
