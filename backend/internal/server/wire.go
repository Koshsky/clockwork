//go:build wireinject
// +build wireinject

package server

import (
	"github.com/google/wire"

	"github.com/Koshsky/erp-backend/internal/audit"
	"github.com/Koshsky/erp-backend/internal/auth"
	authRepo "github.com/Koshsky/erp-backend/internal/auth/repository"
	"github.com/Koshsky/erp-backend/internal/authz"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	authzService "github.com/Koshsky/erp-backend/internal/authz/service"
	autocreate "github.com/Koshsky/erp-backend/internal/auto_create"
	"github.com/Koshsky/erp-backend/internal/cache"
	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/idempotency"
	"github.com/Koshsky/erp-backend/internal/logger"
	authMw "github.com/Koshsky/erp-backend/internal/middleware/auth"
	"github.com/Koshsky/erp-backend/internal/middleware/ratelimit"
	rbacMW "github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/planning"
	projectmgmt "github.com/Koshsky/erp-backend/internal/project_mgmt"
	"github.com/Koshsky/erp-backend/internal/security/hibp"
	"github.com/Koshsky/erp-backend/internal/security/jwt"
	"github.com/Koshsky/erp-backend/internal/server/profiler"
	"github.com/Koshsky/erp-backend/internal/timesheet"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/user"
	userservice "github.com/Koshsky/erp-backend/internal/user/service"
)

// InitializeApp builds the whole application dependency graph.
func InitializeApp() (*App, error) {
	wire.Build(
		config.ProvideConfig,
		logger.ProvideLogger,
		tracingpkg.ProvideTracer,
		config.ProvideTracingConfig,
		database.ProvidePostgresDB,
		config.ProvidePostgresConfig,
		config.ProvideJWTConfig,
		config.ProvideProfilingConfig,
		config.ProvideRBACRefreshInterval,
		config.ProvideAuditConfig,
		config.ProvideSecurityConfig,
		config.ProvideRedisConfig,
		// Shared Redis client (rate limiter backend, M1); nil when disabled.
		cache.ProvideRedisClient,
		// Shared rate limiting provider used by the app routes and the auth
		// module (login/refresh guards).
		ratelimit.ProvideProvider,
		// HIBP breach check for password changes; built from the security config.
		hibp.ProvideChecker,
		idempotency.ProvideIdempotencyRepository,
		idempotency.ProvideIdempotencyMiddleware,
		jwt.ProvideJWTService,
		authMw.ProvideAuthMiddleware,
		rbacMW.ProvideMiddleware,
		engine.ProvideAll,
		profiler.ProvideProfiler,
		ProvideRBACData,
		// The audit client consumes the user service to resolve the `user`
		// filter (login/full name) and to enrich actor display names.
		wire.Bind(new(audit.UserLookup), new(*userservice.UserService)),
		// The auth middleware resolves the caller's current rights from the
		// in-memory RBAC snapshot (PolicyStore) — no per-request DB call.
		wire.Bind(new(authMw.PrincipalResolver), new(*authzService.PolicyStore)),
		// User mutations (preset/account changes) refresh the same snapshot
		// immediately (TTL heals multi-instance).
		wire.Bind(new(userservice.RBACReloader), new(*authzService.PolicyStore)),
		// Credential changes and account deletion revoke the user's refresh
		// sessions (implemented by the auth session repository).
		wire.Bind(new(userservice.SessionRevoker), new(*authRepo.AuthRepository)),

		user.ProviderSet,
		auth.ProviderSet,
		planning.ProviderSet,
		projectmgmt.ProviderSet,
		timesheet.ProviderSet,
		autocreate.ProviderSet,
		authz.ProviderSet,
		audit.ProviderSet,

		ProvideModules,
		New,
	)
	return nil, nil
}
