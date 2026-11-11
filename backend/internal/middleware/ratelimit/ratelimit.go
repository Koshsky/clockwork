package ratelimit

import (
	"log/slog"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/response"
)

// retryAfterSeconds is the Retry-After value sent with a 429 response.
const retryAfterSeconds = "1"

// KeyFunc returns the identity used to bucket clients. Returning the same
// value for several requests groups them into one token bucket; returning a
// distinct value per request gives each its own bucket.
type KeyFunc func(*gin.Context) string

// Config is the rate limiting settings.
type Config struct {
	RequestsPerSecond float64
	Burst             int
	CleanupInterval   time.Duration
	Expiration        time.Duration
	// Key selects the bucket identity (defaults to the client IP when nil).
	Key KeyFunc
}

// FromConfig builds a rate limiting handler from the application configuration,
// keyed by the client IP.
//
// When rate limiting is disabled, a no-op handler is returned.
func FromConfig(cfg config.RateLimitConfig, logger *slog.Logger) gin.HandlerFunc {
	return FromConfigKeyed(cfg, nil, logger)
}

// validateEnabledConfig panics when an enabled rate limit carries values that
// would silently disable the limiter (requests_per_second <= 0) or hard-block
// every request (burst <= 0). config.Load rejects such values at startup; this
// guard is defense-in-depth for direct constructor use — a silent no-op or a
// permanent 429 is never the right outcome for a misconfigured wall.
func validateEnabledConfig(cfg config.RateLimitConfig) {
	if !cfg.Enabled {
		return
	}
	if cfg.RequestsPerSecond <= 0 {
		panic("ratelimit: enabled rate limit requires requests_per_second > 0")
	}
	if cfg.Burst <= 0 {
		panic("ratelimit: enabled rate limit requires burst > 0")
	}
}

// FromConfigKeyed builds a rate limiting handler from the application
// configuration, keyed by key (nil keys by the client IP).
//
// When rate limiting is disabled, a no-op handler is returned; an enabled
// limit with invalid values fails loudly (see validateEnabledConfig).
func FromConfigKeyed(cfg config.RateLimitConfig, key KeyFunc, logger *slog.Logger) gin.HandlerFunc {
	validateEnabledConfig(cfg)
	if !cfg.Enabled {
		return func(c *gin.Context) {
			c.Next()
		}
	}

	return New(Config{
		RequestsPerSecond: cfg.RequestsPerSecond,
		Burst:             cfg.Burst,
		CleanupInterval:   time.Duration(cfg.CleanupInterval),
		Expiration:        time.Duration(cfg.Expiration),
		Key:               key,
	}, logger)
}

// New builds a per-key token bucket middleware. The bucket identity is chosen
// by config.Key; when it is nil the client IP is used.
//
// The returned handler runs a background cleanup goroutine for the lifetime
// of the process; it prunes limiters that were not used for the expiration
// period so the client map does not grow unbounded.
func New(config Config, logger *slog.Logger) gin.HandlerFunc {
	if config.RequestsPerSecond <= 0 {
		return func(c *gin.Context) {
			c.Next()
		}
	}

	if logger == nil {
		logger = slog.Default()
	}
	logger = logger.With("component", "ratelimit")

	clientLimit := rate.Limit(config.RequestsPerSecond)
	keyFunc := config.Key
	if keyFunc == nil {
		keyFunc = func(c *gin.Context) string { return c.ClientIP() }
	}

	var mu sync.Mutex
	limiters := make(map[string]*clientLimiter)

	go func() {
		ticker := time.NewTicker(config.CleanupInterval)
		defer ticker.Stop()

		for range ticker.C {
			pruneExpired(limiters, &mu, config.Expiration, time.Now())
		}
	}()

	return func(c *gin.Context) {
		key := keyFunc(c)

		mu.Lock()
		cl, ok := limiters[key]
		if !ok {
			cl = &clientLimiter{
				limiter: rate.NewLimiter(clientLimit, config.Burst),
			}
			limiters[key] = cl
		}
		cl.lastSeen = time.Now()
		mu.Unlock()

		if !cl.limiter.Allow() {
			c.Header("Retry-After", retryAfterSeconds)
			logger.WarnContext(c.Request.Context(), "rate limit exceeded", "client_ip", key)
			response.TooManyRequests(c, "too many requests")
			c.Abort()
			return
		}

		c.Next()
	}
}

// clientLimiter is a per-client token bucket with its last seen timestamp.
type clientLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// pruneExpired removes limiters that were not used for the expiration period.
func pruneExpired(limiters map[string]*clientLimiter, mu *sync.Mutex, expiration time.Duration, now time.Time) {
	mu.Lock()
	defer mu.Unlock()

	for key, cl := range limiters {
		if now.Sub(cl.lastSeen) > expiration {
			delete(limiters, key)
		}
	}
}
