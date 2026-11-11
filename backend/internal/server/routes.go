//	@title			Enterprise Resource Planning
//	@version		1.0
//	@description	For managing the enterprise's universal resources
//	@termsOfService	http://swagger.io/terms/

//	@contact.name	Shmonov Matvey
//	@contact.url	https://t.me/Koshsky
//	@contact.email	shmonov.mv@gmail.com

//	@license.name	Apache 2.0
//	@license.url	http://www.apache.org/licenses/LICENSE-2.0.html

// Note (AD-14): host is a placeholder until a domain appears; aligned with
// the dev deployment (http, localhost:8080) — swagger is disabled in prod
// (M6) and only served by the dev-only cmd/swagger/main.go on :8080.
//	@host		localhost:8080
//	@schemes	http
//	@BasePath	/api/v1

//	@securityDefinitions.apikey	ApiKeyAuth
//	@in							header
//	@name						Authorization
//	@description				"Provide JWT token in the format: Bearer {token}"

//	@externalDocs.description	ERP documentation (placeholder)
//	@externalDocs.url			https://swagger.io/resources/open-api/

// Package server wires the HTTP routes and assembles the application.
package server

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

// registerRoutes registers every module's routes: public ones on the api
// group behind a per-IP limiter, protected ones on a sibling group behind
// RequireAuth and a per-user limiter. Protected routes are a sibling group
// (not a child of api) so they do NOT inherit the public per-IP limiter: a
// heavy authenticated user behind a shared NAT must not drain a common IP
// bucket and block its neighbors. Instead every authenticated user gets its
// own token bucket keyed by user id.
func (a *App) registerRoutes(router *gin.Engine) {
	api := router.Group("/api/v1")
	api.Use(a.tracer.GinSpan("middleware.ratelimit.public"))
	api.Use(a.rateLimiter.FromConfig(a.cfg.RateLimit))
	// Audit capture for the public routes (only the /auth/* mutations are
	// classified; everything else passes through untouched).
	if a.auditMw != nil {
		api.Use(a.auditMw.Handler())
	}

	// Health: liveness probe without authorization. The frontend uses it to
	// check backend availability before offline sync (instead of static files).
	api.GET("/health", a.health)

	for _, m := range a.modules {
		m.RegisterPublicRoutes(api)
	}

	protected := router.Group("/api/v1")
	protected.Use(a.tracer.GinSpan("middleware.auth"))
	protected.Use(a.authMw.RequireAuth())
	// Audit capture for protected routes: runs right after auth (so the actor
	// is known) and before idempotency/handlers, reading the body first and
	// restoring it for the downstream chain.
	if a.auditMw != nil {
		protected.Use(a.tracer.GinSpan("middleware.audit"))
		protected.Use(a.auditMw.Handler())
	}
	// Idempotency-Key: pass-through without a header; with a header — idempotent
	// create (replay-safe). Mounted globally on protected, since the key is
	// scoped by (key, user_id, method, path) and active only when an
	// Idempotency-Key header is present.
	protected.Use(a.tracer.GinSpan("middleware.idempotency"))
	protected.Use(a.idemMw.Handler())
	protected.Use(a.tracer.GinSpan("middleware.ratelimit.user"))
	protected.Use(a.rateLimiter.FromConfigKeyed(a.cfg.UserRateLimit, a.userKey))
	for _, m := range a.modules {
		m.RegisterProtectedRoutes(protected)
	}
}

// userKey selects the token bucket identity for an authenticated request: the
// JWT user id. It runs after RequireAuth, which guarantees the user context is
// present; on any unexpected miss it falls back to a constant key so a
// misbehaving request shares one bucket instead of allocating unbounded ones.
func (a *App) userKey(c *gin.Context) string {
	id, err := userctx.GetUserID(c)
	if err != nil {
		return "anonymous"
	}
	return strconv.FormatInt(id, 10)
}

// health responds 200 with the liveness-probe status "ok".
func (a *App) health(c *gin.Context) {
	response.OK(c, gin.H{"status": "ok"})
}
