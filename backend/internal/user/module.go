// Package user wires the user module's providers and routes.
package user

import (
	"log/slog"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/middleware/ratelimit"
	"github.com/Koshsky/erp-backend/internal/user/delivery"
	"github.com/Koshsky/erp-backend/internal/user/repository"
	"github.com/Koshsky/erp-backend/internal/user/service"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// change-password limit (per user) — brute-force protection for the old password.
// A uniform delay so the result is not leaked through response timing.
const (
	changePasswordRatePerSecond  = 0.5
	changePasswordBurst          = 3
	changePasswordCleanupEvery   = time.Minute
	changePasswordLimitExpiresIn = 10 * time.Minute
	changePasswordResponseDelay  = 300 * time.Millisecond
)

// ProviderSet aggregates the user module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	repository.NewUserRepository,
	service.NewUserService,
	delivery.NewUserHandler,
	ProvideModule,
)

// Module registers the user module's routes (all protected).
type Module struct {
	handler *delivery.UserHandler
	logger  *slog.Logger
}

// ProvideModule builds the user module.
func ProvideModule(handler *delivery.UserHandler, logger *slog.Logger) Module {
	return Module{handler: handler, logger: logger.With("component", "user_module")}
}

// changePasswordGuard returns a per-user (by JWT id) limiter for
// /user/change-password; the uniform delay is applied before the limiter.
func (m Module) changePasswordGuard() gin.HandlerFunc {
	limiter := ratelimit.New(ratelimit.Config{
		RequestsPerSecond: changePasswordRatePerSecond,
		Burst:             changePasswordBurst,
		CleanupInterval:   changePasswordCleanupEvery,
		Expiration:        changePasswordLimitExpiresIn,
		Key: func(c *gin.Context) string {
			id, err := userctx.GetUserID(c)
			if err != nil {
				// userctx must be present on the protected route; on any miss —
				// a shared bucket, so unbounded limiters are not created.
				return "unknown"
			}
			return strconv.FormatInt(id, 10)
		},
	}, m.logger)

	return func(c *gin.Context) {
		time.Sleep(changePasswordResponseDelay)
		limiter(c)
	}
}

// RegisterPublicRoutes is a no-op: the user module has no public routes.
func (m Module) RegisterPublicRoutes(_ *gin.RouterGroup) {
}

// RegisterProtectedRoutes registers the user routes behind authentication.
func (m Module) RegisterProtectedRoutes(r *gin.RouterGroup) {
	m.handler.RegisterRoutes(r, m.changePasswordGuard())
}
