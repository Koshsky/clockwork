//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
	"github.com/Koshsky/erp-backend/internal/auto_create/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/database"
)

type AutoCreateRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewAutoCreateRepository builds the AutoCreateRepository repository.
func NewAutoCreateRepository(logger *slog.Logger, pool *pgxpool.Pool) *AutoCreateRepository {
	return &AutoCreateRepository{
		logger: logger.With("component", "auto_create_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *AutoCreateRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

// GetConfig returns the current config (empty + disabled when not set yet).
func (r *AutoCreateRepository) GetConfig(ctx context.Context) (*dto.AutoCreateConfig, error) {
	row, err := r.q(ctx).GetAutoCreateConfig(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &dto.AutoCreateConfig{Enabled: false, Processes: []dto.ProcessTemplate{}}, nil
		}
		return nil, err
	}

	var processes []dto.ProcessTemplate
	if err = json.Unmarshal(row.Config, &processes); err != nil {
		return nil, err
	}
	if processes == nil {
		processes = []dto.ProcessTemplate{}
	}
	return &dto.AutoCreateConfig{Enabled: row.Enabled, Processes: processes}, nil
}

// UpsertConfig replaces the whole config (single row id=1).
func (r *AutoCreateRepository) UpsertConfig(ctx context.Context, cfg *dto.AutoCreateConfig) error {
	raw, err := json.Marshal(cfg.Processes)
	if err != nil {
		return err
	}
	_, err = r.q(ctx).UpsertAutoCreateConfig(ctx, sqlc.UpsertAutoCreateConfigParams{
		Enabled: cfg.Enabled,
		Config:  raw,
	})
	return err
}

// ExistingResources returns the set of active resource ids present among ids.
func (r *AutoCreateRepository) ExistingResources(ctx context.Context, ids []int64) (map[int64]struct{}, error) {
	rows, err := r.q(ctx).ListExistingResources(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]struct{}, len(rows))
	for _, id := range rows {
		out[id] = struct{}{}
	}
	return out, nil
}

// ExistingUsers returns the set of active user ids present among ids.
func (r *AutoCreateRepository) ExistingUsers(ctx context.Context, ids []int64) (map[int64]struct{}, error) {
	rows, err := r.q(ctx).ListExistingUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]struct{}, len(rows))
	for _, id := range rows {
		out[id] = struct{}{}
	}
	return out, nil
}
