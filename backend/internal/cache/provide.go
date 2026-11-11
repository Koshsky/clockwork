// Package cache provides the shared Redis connection used by infra
// middlewares (currently the rate limiter, M1).
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/Koshsky/erp-backend/internal/config"
)

// pingTimeout bounds the startup connectivity check.
const pingTimeout = 3 * time.Second

// ProvideRedisClient builds the shared Redis client from the configuration
// (M1). The limiter backend is chosen explicitly by config: disabled Redis
// selects the in-memory implementation (nil client); an enabled but
// unreachable Redis fails application startup with an error (fail-fast), so a
// deployment configured for Redis never silently runs without distributed
// limits.
//
//nolint:nilnil // a nil client is the documented "in-memory implementation" value, not an error state
func ProvideRedisClient(cfg config.RedisConfig, logger *slog.Logger) (*redis.Client, error) {
	logger = logger.With("component", "cache_redis")
	if !cfg.Enabled {
		logger.Info("redis disabled, rate limiter will use the in-memory implementation")
		return nil, nil
	}

	client := redis.NewClient(&redis.Options{
		Addr:         cfg.Address,
		Password:     cfg.Password,
		DB:           cfg.DB,
		DialTimeout:  time.Duration(cfg.DialTimeout),
		ReadTimeout:  time.Duration(cfg.ReadTimeout),
		WriteTimeout: time.Duration(cfg.WriteTimeout),
		PoolSize:     cfg.PoolSize,
	})

	ctx, cancel := context.WithTimeout(context.Background(), pingTimeout)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis enabled in config but unreachable at %s: %w", cfg.Address, err)
	}

	logger.Info("redis connected", "address", cfg.Address, "db", cfg.DB)
	return client, nil
}
