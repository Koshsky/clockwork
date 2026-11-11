package idempotency

import (
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/idempotency/repository"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

// ProvideIdempotencyRepository builds the idempotency key repository.
func ProvideIdempotencyRepository(pool *pgxpool.Pool) *repository.IdempotencyRepository {
	return repository.NewIdempotencyRepository(pool)
}

// ProvideIdempotencyMiddleware builds the Idempotency-Key middleware.
func ProvideIdempotencyMiddleware(
	repo *repository.IdempotencyRepository,
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
) *Middleware {
	return New(repo, logger, tracer)
}
