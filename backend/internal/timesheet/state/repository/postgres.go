//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type StateRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewStateRepository builds the StateRepository repository.
func NewStateRepository(logger *slog.Logger, pool *pgxpool.Pool) *StateRepository {
	return &StateRepository{
		logger: logger.With("component", "state_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *StateRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *StateRepository) CreateState(
	ctx context.Context,
	code, name string,
	isAvailable bool,
	color *string,
) (*sqlc.State, error) {
	row, err := r.q(ctx).CreateState(ctx, sqlc.CreateStateParams{
		Code:        code,
		Name:        name,
		IsAvailable: isAvailable,
		Color:       nullable.ToString(color),
	})
	if err != nil {
		// Idempotent create: the code already exists (ON CONFLICT
		// inserted nothing) — this is a business-key conflict, not an internal error.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errapi.Conflict("state with this code already exists")
		}
		return nil, err
	}
	return &row, nil
}

func (r *StateRepository) FindState(ctx context.Context, id int64) (*sqlc.State, error) {
	row, err := r.q(ctx).FindState(ctx, id)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *StateRepository) UpdateState(ctx context.Context, state sqlc.State) (*sqlc.State, error) {
	row, err := r.q(ctx).UpdateState(ctx, sqlc.UpdateStateParams{
		StateID:     state.ID,
		Code:        state.Code,
		Name:        state.Name,
		IsAvailable: state.IsAvailable,
		Color:       state.Color,
	})
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *StateRepository) DeleteState(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteState(ctx, id)
}

func (r *StateRepository) ListStates(ctx context.Context) ([]sqlc.State, error) {
	return r.q(ctx).ListStates(ctx)
}
