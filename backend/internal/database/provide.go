package database

import (
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/diagnostics"
	"github.com/Koshsky/erp-backend/internal/metrics"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

// ProvidePostgresDB initializes the database pool with SQL query tracing.
func ProvidePostgresDB(
	pgCfg config.PostgresConfig,
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	observer *metrics.Metrics,
	outcomes *diagnostics.Outcomes,
) (*pgxpool.Pool, error) {
	return InitDBPool(pgCfg, logger, tracer, observer, outcomes)
}
