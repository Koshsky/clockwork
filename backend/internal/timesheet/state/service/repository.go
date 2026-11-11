package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/timesheet/state/repository/sqlc"
)

type StateRepository interface {
	CreateState(ctx context.Context, code, name string, isAvailable bool, color *string) (*sqlc.State, error)
	FindState(ctx context.Context, id int64) (*sqlc.State, error)
	UpdateState(ctx context.Context, state sqlc.State) (*sqlc.State, error)
	DeleteState(ctx context.Context, id int64) error
	ListStates(ctx context.Context) ([]sqlc.State, error)
}
