package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/Koshsky/erp-backend/internal/audit"
	authzService "github.com/Koshsky/erp-backend/internal/authz/service"
	"github.com/Koshsky/erp-backend/internal/config"
	idempotencypkg "github.com/Koshsky/erp-backend/internal/idempotency"
	"github.com/Koshsky/erp-backend/internal/middleware/auth"
	"github.com/Koshsky/erp-backend/internal/middleware/cors"
	"github.com/Koshsky/erp-backend/internal/middleware/locale"
	"github.com/Koshsky/erp-backend/internal/middleware/ratelimit"
	tracingmw "github.com/Koshsky/erp-backend/internal/middleware/tracing"
	"github.com/Koshsky/erp-backend/internal/server/profiler"
	"github.com/Koshsky/erp-backend/internal/server/swagger"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userservice "github.com/Koshsky/erp-backend/internal/user/service"
)

const (
	defaultServerStartTimeout = 5 * time.Second
	defaultDialTimeout        = 1 * time.Second
	defaultPollInterval       = 100 * time.Millisecond
	// bootstrapTimeout bounds the first-launch administrator bootstrap (one
	// lookup plus one insert): a hung database must not block startup forever.
	bootstrapTimeout = 10 * time.Second
)

type App struct {
	version     string
	cfg         *config.Config
	logger      *slog.Logger
	pool        *pgxpool.Pool
	httpServer  *http.Server
	redisClient *redis.Client
	rateLimiter *ratelimit.Provider
	profiler    *profiler.Profiler
	authMw      *auth.Middleware
	tracer      *tracingpkg.Tracer
	idemMw      *idempotencypkg.Middleware
	auditMw     *audit.Middleware
	policyStore *authzService.PolicyStore
	userSvc     *userservice.UserService
	modules     []Module
}

// New wires the application with its injected dependencies.
func New(
	cfg *config.Config,
	logger *slog.Logger,
	pool *pgxpool.Pool,
	authMw *auth.Middleware,
	profiler *profiler.Profiler,
	tracer *tracingpkg.Tracer,
	idemMw *idempotencypkg.Middleware,
	auditMw *audit.Middleware,
	policyStore *authzService.PolicyStore,
	userSvc *userservice.UserService,
	redisClient *redis.Client,
	rateLimiter *ratelimit.Provider,
	modules []Module,
) (*App, error) {
	return &App{
		cfg:         cfg,
		logger:      logger.With("component", "server"),
		pool:        pool,
		authMw:      authMw,
		profiler:    profiler,
		redisClient: redisClient,
		rateLimiter: rateLimiter,
		tracer:      tracer,
		idemMw:      idemMw,
		auditMw:     auditMw,
		policyStore: policyStore,
		userSvc:     userSvc,
		modules:     modules,
	}, nil
}

// ensureAdmin creates the administrator account on the first launch (the
// password comes from ADMIN_PASSWORD); an existing account is left untouched.
// A failure is fatal on purpose: without an administrator the deployment cannot
// be administered at all, and coming up half-configured is worse than not
// coming up.
func (a *App) ensureAdmin() error {
	if a.userSvc == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), bootstrapTimeout)
	defer cancel()
	_, err := a.userSvc.EnsureAdmin(ctx, a.cfg.Admin.Password)
	return err
}

// Logger returns the application logger.
func (a *App) Logger() *slog.Logger {
	return a.logger
}

func (a *App) Start() error {
	// First-launch bootstrap: the administrator account is created here (from
	// ADMIN_PASSWORD) instead of shipping in the seeds. Runs before the RBAC
	// store starts so the published snapshot already knows the new principal.
	if err := a.ensureAdmin(); err != nil {
		return fmt.Errorf("admin bootstrap: %w", err)
	}

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()

	// Only trust the reverse proxy (nginx) as a source of client IP headers.
	// Gin defaults to trusting every peer, which lets remote clients spoof
	// X-Forwarded-For and bypass the per-IP rate limiter. An invalid/empty
	// list falls back to "trust nobody": ClientIP() then returns the proxy's
	// own IP, so all traffic shares one bucket instead of being bypassable.
	if err := router.SetTrustedProxies(a.cfg.HTTPServer.TrustedProxies); err != nil {
		a.logger.Error("invalid trusted_proxies config, rate limit will key on the proxy IP",
			"error", err, "trusted_proxies", a.cfg.HTTPServer.TrustedProxies)
		_ = router.SetTrustedProxies(nil)
	}

	a.profiler.Start()
	if a.policyStore != nil {
		a.policyStore.Start()
	}
	if a.auditMw != nil {
		a.auditMw.Start()
	}

	if a.cfg.Swagger.Enabled {
		// Swagger is outside /api/v1; keep a public per-IP wall on it.
		swag := router.Group("/swagger")
		swag.Use(a.rateLimiter.FromConfig(a.cfg.RateLimit))
		swagger.Register(swag)
	}

	// Register middleware. Locale resolution comes first so every later
	// middleware (recovery, rate limits, auth) and every handler renders its
	// user-facing messages in the client's language. The rate limiter is
	// intentionally NOT mounted here globally: public routes are limited
	// per-IP and protected routes per-user (see registerRoutes), so a heavy
	// user behind a shared NAT does not drain a common IP bucket and block
	// their neighbors.
	router.Use(locale.Middleware())
	router.Use(cors.FromConfig(a.cfg.CORS))
	// Assign a server-owned request id before diagnostic middleware.
	router.Use(a.requestID())
	// H3: bound the request body size and the per-request context lifetime
	// before anything (audit/tracing/handlers) reads the body or starts work.
	router.Use(a.bodyLimit())
	router.Use(a.requestTimeout())
	// Keep route-level correlation without exporting object or account identities.
	router.Use(tracingmw.HTTPRootSpan(a.tracer))
	// Fallback text request logging (independent of tracing).
	router.Use(a.requestLog())
	router.Use(a.recovery())
	// Register routes
	a.registerRoutes(router)

	// Create HTTP server with configurable settings
	srvCfg := a.cfg.HTTPServer
	a.httpServer = &http.Server{
		Addr:         fmt.Sprintf(":%d", srvCfg.Port),
		Handler:      router,
		ReadTimeout:  time.Duration(srvCfg.ReadTimeout),
		WriteTimeout: time.Duration(srvCfg.WriteTimeout),
		IdleTimeout:  time.Duration(srvCfg.IdleTimeout),
	}

	go func() {
		a.logger.Info("starting HTTP server",
			"addr", a.httpServer.Addr,
			"read_timeout", srvCfg.ReadTimeout,
			"write_timeout", srvCfg.WriteTimeout,
			"idle_timeout", srvCfg.IdleTimeout,
		)
		if err := a.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			a.logger.Error("HTTP server error", "error", err)
		}
	}()

	if err := a.waitForServer(defaultServerStartTimeout); err != nil {
		return fmt.Errorf("server failed to start: %w", err)
	}
	return nil
}

func (a *App) waitForServer(timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	addr := fmt.Sprintf("localhost:%d", a.cfg.HTTPServer.Port)

	dialer := &net.Dialer{
		Timeout: defaultDialTimeout,
	}

	for {
		conn, err := dialer.DialContext(ctx, "tcp", addr)
		if err == nil {
			_ = conn.Close()
			return nil
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("timeout waiting for server: %w", ctx.Err())
		default:
		}

		time.Sleep(defaultPollInterval)
	}
}

func (a *App) Stop(ctx context.Context) error {
	if a.policyStore != nil {
		a.policyStore.Stop()
	}
	if a.auditMw != nil {
		a.auditMw.Stop(ctx)
	}
	if a.pool != nil {
		a.pool.Close()
	}
	if a.redisClient != nil {
		if err := a.redisClient.Close(); err != nil {
			a.logger.WarnContext(ctx, "redis client close failed", "error", err)
		}
	}
	if err := a.profiler.Stop(ctx); err != nil {
		return err
	}
	if a.tracer != nil {
		if err := a.tracer.Shutdown(ctx); err != nil {
			a.logger.ErrorContext(ctx, "tracing shutdown failed", "error", err)
		}
	}
	if a.httpServer != nil {
		return a.httpServer.Shutdown(ctx)
	}
	return nil
}

// requestID is server-owned so arbitrary inbound headers cannot become log data.
func (a *App) requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		reqID := newRequestID()
		c.Set(tracingpkg.RequestIDKey, reqID)
		c.Header("X-Request-ID", reqID)
		c.Request = c.Request.WithContext(tracingpkg.WithRequestID(c.Request.Context(), reqID))
		c.Next()
	}
}

func (a *App) recovery() gin.HandlerFunc {
	// Gin's default writer includes headers, panic text and source paths.
	return gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, _ any) {
		a.logger.ErrorContext(c.Request.Context(), "request panic")
		c.AbortWithStatus(http.StatusInternalServerError)
	})
}

// newRequestID generates a 128-bit random hex id (crypto/rand; the same
// pattern as the JWT token id, avoiding a UUID dependency).
func newRequestID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	// crypto/rand practically never fails; a time-based fallback keeps the
	// id unique enough for correlation.
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

// requestLog writes a summary of every HTTP request (method, path, status,
// duration) to the log using only registered route templates. Unknown paths
// and query strings are untrusted data, including when routing fails.
// Context-aware logging attaches the request id and the trace ids.
func (a *App) requestLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		a.logger.InfoContext(c.Request.Context(), "request",
			"method", c.Request.Method,
			"route", c.FullPath(),
			"status", c.Writer.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", c.GetString(tracingpkg.RequestIDKey),
		)
	}
}

// bodyLimit wraps the request body with [http.MaxBytesReader] so oversized
// bodies fail on read with "http: request body too large" (a 400-class error
// via the handlers' binding error path) instead of being buffered unboundedly
// (H3). A non-positive limit disables the check.
func (a *App) bodyLimit() gin.HandlerFunc {
	limit := a.cfg.HTTPServer.MaxBodyBytes
	if limit <= 0 {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	}
}

// requestTimeout cancels the request context after the configured timeout
// (H3): long-running handlers (planning/calendar aggregates) and their DB
// queries are aborted, releasing goroutines and pool connections. A
// non-positive timeout disables the middleware.
func (a *App) requestTimeout() gin.HandlerFunc {
	timeout := time.Duration(a.cfg.HTTPServer.RequestTimeout)
	if timeout <= 0 {
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}
