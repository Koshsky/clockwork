package ratelimit

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/Koshsky/erp-backend/internal/config"
)

// Provider builds rate limiting handlers backed by a shared Redis client when
// available (M1) and by the in-memory token buckets otherwise. The backend is
// chosen explicitly by config: a live client means redis.enabled=true, a nil
// client means redis.enabled=false — an enabled but unreachable Redis fails
// startup in cache.ProvideRedisClient and never reaches the provider. All
// instances share one Provider through wire, so every limiter (public
// per-IP, per-user, auth login/refresh) reads the same Redis keys.
type Provider struct {
	client *redis.Client
	prefix string
	logger *slog.Logger
}

// ProvideProvider wires the shared rate limiting provider. A nil Redis client
// (Redis disabled in config) selects the in-memory implementation; an
// enabled-but-unreachable Redis fails startup in cache.ProvideRedisClient and
// never reaches the provider.
func ProvideProvider(client *redis.Client, cfg config.RedisConfig, logger *slog.Logger) *Provider {
	if logger == nil {
		logger = slog.Default()
	}
	prefix := cfg.KeyPrefix
	if prefix == "" {
		prefix = "erp:ratelimit"
	}
	return &Provider{client: client, prefix: prefix, logger: logger.With("component", "ratelimit")}
}

// New builds a rate limiting handler from a raw limiter configuration, using
// the Redis backend when the provider has a live client.
func (p *Provider) New(cfg Config) gin.HandlerFunc {
	if cfg.RequestsPerSecond <= 0 {
		return func(c *gin.Context) { c.Next() }
	}

	keyFunc := cfg.Key
	if keyFunc == nil {
		keyFunc = func(c *gin.Context) string { return c.ClientIP() }
	}

	if p.client != nil {
		limiter := &redisLimiter{
			client:  p.client,
			prefix:  p.prefix,
			keyFunc: keyFunc,
			rate:    cfg.RequestsPerSecond,
			burst:   cfg.Burst,
			ttl:     cfg.Expiration,
			logger:  p.logger,
		}
		return limiter.handler()
	}

	return New(Config{
		RequestsPerSecond: cfg.RequestsPerSecond,
		Burst:             cfg.Burst,
		CleanupInterval:   cfg.CleanupInterval,
		Expiration:        cfg.Expiration,
		Key:               keyFunc,
	}, p.logger)
}

// FromConfig builds a handler from the application rate limiting settings,
// keyed by the client IP. Disabled limits produce a transparent handler.
func (p *Provider) FromConfig(cfg config.RateLimitConfig) gin.HandlerFunc {
	return p.FromConfigKeyed(cfg, nil)
}

// FromConfigKeyed builds a handler from the application settings with an
// explicit bucket key (nil keys by the client IP). Disabled limits produce a
// transparent handler; an enabled limit with invalid values fails loudly (see
// validateEnabledConfig).
func (p *Provider) FromConfigKeyed(cfg config.RateLimitConfig, key KeyFunc) gin.HandlerFunc {
	validateEnabledConfig(cfg)
	if !cfg.Enabled {
		return func(c *gin.Context) { c.Next() }
	}
	return p.New(Config{
		RequestsPerSecond: cfg.RequestsPerSecond,
		Burst:             cfg.Burst,
		CleanupInterval:   time.Duration(cfg.CleanupInterval),
		Expiration:        time.Duration(cfg.Expiration),
		Key:               key,
	})
}
