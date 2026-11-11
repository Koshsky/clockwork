// Package auth wires the auth module's providers and routes.
package auth

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/auth/delivery"
	"github.com/Koshsky/erp-backend/internal/auth/repository"
	"github.com/Koshsky/erp-backend/internal/auth/service"
	"github.com/Koshsky/erp-backend/internal/middleware/ratelimit"
)

// login rate limit (per IP) — stricter than the global API limit to slow
// down password brute-forcing on /auth/login.
const (
	loginRatePerSecond  = 1.0
	loginBurst          = 5
	loginCleanupEvery   = time.Minute
	loginLimitExpiresIn = 10 * time.Minute
	// loginResponseDelay uniformly slows every /auth/login response so that
	// timing does not reveal whether a username exists (anti-enumeration).
	//
	// Deliberately kept synchronous (L10): each 500 ms sleep occupies only a
	// goroutine — no DB connection, pool slot or rate-limit bucket is held —
	// and the login limiter (1 rps/ip, burst 5) caps how many sleeps can run
	// concurrently per client. An async "delayed response" would require
	// buffering replies per connection and buy nothing here.
	loginResponseDelay = 500 * time.Millisecond
)

// refresh rate limit (per IP) — stricter than the global API limit: refresh
// tokens are 256-bit (guessing is unrealistic); the limit curbs
// abuse/DoS against /auth/refresh.
const (
	refreshRatePerSecond  = 2.0
	refreshBurst          = 10
	refreshCleanupEvery   = time.Minute
	refreshLimitExpiresIn = 10 * time.Minute
)

// ProviderSet aggregates the auth module's dependencies.
//
//nolint:gochecknoglobals // wire provider set (established module pattern)
var ProviderSet = wire.NewSet(
	service.NewAuthService,
	repository.NewAuthRepository,
	delivery.NewAuthHandler,
	ProvideModule,
)

// Module registers the auth module's routes. All auth routes are public
// (register/login/refresh); there are no protected auth routes.
type Module struct {
	handler     *delivery.AuthHandler
	logger      *slog.Logger
	rateLimiter *ratelimit.Provider
}

// ProvideModule builds the auth module.
func ProvideModule(
	handler *delivery.AuthHandler,
	logger *slog.Logger,
	rateLimiter *ratelimit.Provider,
) Module {
	return Module{handler: handler, logger: logger.With("component", "auth_module"), rateLimiter: rateLimiter}
}

// loginGuard returns a per-IP rate limiter applied to the login endpoint.
// The uniform loginResponseDelay is applied before the limiter so that timing
// does not reveal whether a username exists.
func (m Module) loginGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		time.Sleep(loginResponseDelay)
		m.limiter(loginRatePerSecond, loginBurst, loginCleanupEvery, loginLimitExpiresIn)(c)
	}
}

// refreshGuard returns a per-IP rate limiter applied to the endpoint /auth/refresh.
func (m Module) refreshGuard() gin.HandlerFunc {
	return m.limiter(refreshRatePerSecond, refreshBurst, refreshCleanupEvery, refreshLimitExpiresIn)
}

// limiter builds a per-IP token bucket middleware (Redis-backed when the
// provider has a live client, in-memory otherwise, M1).
func (m Module) limiter(perSecond float64, burst int, cleanup, expiration time.Duration) gin.HandlerFunc {
	return m.rateLimiter.New(ratelimit.Config{
		RequestsPerSecond: perSecond,
		Burst:             burst,
		CleanupInterval:   cleanup,
		Expiration:        expiration,
	})
}

// RegisterPublicRoutes registers the auth routes without authentication.
func (m Module) RegisterPublicRoutes(r *gin.RouterGroup) {
	m.handler.RegisterRoutes(r, m.loginGuard(), m.refreshGuard())
}

// RegisterProtectedRoutes is a no-op: auth has no protected routes.
func (m Module) RegisterProtectedRoutes(_ *gin.RouterGroup) {
}
