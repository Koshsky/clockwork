package database

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/migration"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

func InitDBPool(pgCfg config.PostgresConfig, logger *slog.Logger, tracer *tracingpkg.Tracer) (*pgxpool.Pool, error) {
	const op = "initDBPool"

	migrationLogger := logger
	logger = logger.With("component", "database")

	cfg, err := pgxpool.ParseConfig(pgCfg.URL)
	if err != nil {
		return nil, fmt.Errorf("%s: parse config: %w", op, err)
	}

	cfg.MaxConns = pgCfg.MaxConns
	cfg.MinConns = pgCfg.MinConns
	cfg.MaxConnLifetime = time.Duration(pgCfg.MaxConnLifetime)
	cfg.MaxConnIdleTime = time.Duration(pgCfg.MaxConnIdleTime)
	cfg.HealthCheckPeriod = time.Duration(pgCfg.HealthCheckPeriod)
	cfg.ConnConfig.ConnectTimeout = time.Duration(pgCfg.ConnectTimeout)

	// Instrument every SQL query (Exec/Query/QueryRow across all repositories)
	// with an OpenTelemetry span. The tracer is a no-op when tracing is off.
	if tracer != nil {
		cfg.ConnConfig.Tracer = tracingpkg.NewQueryTracer(tracer.Unwrap())
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(pgCfg.ConnectTimeout))
	defer cancel()

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("%s: create pool: %w", op, err)
	}

	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("%s: ping: %w", op, err)
	}

	// Construct repositories only after the schema and its history are validated.
	const migrationTimeout = 5 * time.Minute
	migrationCtx, migrationCancel := context.WithTimeout(context.Background(), migrationTimeout)
	defer migrationCancel()
	if err = migration.Run(migrationCtx, pool, migrationLogger); err != nil {
		pool.Close()
		return nil, fmt.Errorf("%s: migrate: %w", op, err)
	}

	stats := pool.Stat()
	logger.Info("database connected",
		"max_conns", cfg.MaxConns,
		"min_conns", cfg.MinConns,
		"acquired_conns", stats.AcquiredConns(),
		"total_conns", stats.TotalConns(),
	)

	return pool, nil
}
