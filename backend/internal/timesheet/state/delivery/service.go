package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/timesheet/state/dto"
)

type StateService interface {
	ListStates(ctx context.Context) ([]dto.StateResponse, error)
	FindState(ctx context.Context, id int64) (*dto.StateResponse, error)
	CreateState(ctx context.Context, state dto.CreateStateRequest) (*dto.StateResponse, error)
	DeleteState(ctx context.Context, id int64) error
	UpdateState(ctx context.Context, id int64, state dto.UpdateStateRequest) (*dto.StateResponse, error)
}
