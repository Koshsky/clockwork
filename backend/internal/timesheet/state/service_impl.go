package state

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/Koshsky/erp-backend/internal/timesheet/state/dto"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type Service struct {
	logger     *slog.Logger
	repository Repository
	mapper     *Mapper
	validator  *Validator
	tracer     *tracingpkg.Tracer
}

// NewService builds the state service.
func NewService(logger *slog.Logger, tracer *tracingpkg.Tracer, r Repository) *Service {
	return &Service{
		logger:     logger.With("component", "state_service"),
		repository: r,
		mapper:     NewMapper(),
		validator:  &Validator{},
		tracer:     tracer,
	}
}

func (s *Service) ListStates(ctx context.Context) ([]dto.StateResponse, error) {
	ctx, end := s.tracer.Start(ctx, "state.ListStates")
	defer end(nil)
	states, err := s.repository.ListStates(ctx)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTOs(states), nil
}

func (s *Service) CreateState(ctx context.Context, req dto.CreateStateRequest) (*dto.StateResponse, error) {
	ctx, end := s.tracer.Start(ctx, "state.CreateState")
	defer end(nil)

	if err := s.validator.ValidateState(req.Code, req.Name, req.Color); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateState(ctx, req.Code, req.Name, req.IsAvailable, req.Color)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(created), nil
}

func (s *Service) FindState(ctx context.Context, id int64) (*dto.StateResponse, error) {
	ctx, end := s.tracer.Start(ctx, "state.FindState")
	defer end(nil)

	state, err := s.repository.FindState(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.ErrStateNotFound
		}
		return nil, err
	}
	if state == nil {
		return nil, errors.ErrStateNotFound
	}
	return s.mapper.ToDTO(state), nil
}

func (s *Service) UpdateState(
	ctx context.Context,
	id int64,
	req dto.UpdateStateRequest,
) (*dto.StateResponse, error) {
	ctx, end := s.tracer.Start(ctx, "state.UpdateState")
	defer end(nil)

	state, err := s.repository.FindState(ctx, id)
	if err != nil || state == nil {
		return nil, errors.ErrStateNotFound
	}

	if req.Code != nil {
		state.Code = *req.Code
	}
	if req.Name != nil {
		state.Name = *req.Name
	}
	if req.IsAvailable != nil {
		state.IsAvailable = *req.IsAvailable
	}
	if req.Color != nil {
		if *req.Color == "" {
			state.Color = sql.NullString{}
		} else {
			state.Color = sql.NullString{String: *req.Color, Valid: true}
		}
	}
	if err = s.validator.ValidateState(state.Code, state.Name, nullable.StringPtr(state.Color)); err != nil {
		return nil, err
	}

	updated, err := s.repository.UpdateState(ctx, *state)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(updated), nil
}

func (s *Service) DeleteState(ctx context.Context, id int64) error {
	ctx, end := s.tracer.Start(ctx, "state.DeleteState")
	defer end(nil)

	state, err := s.repository.FindState(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete: already deleted — not an error
		}
		return err
	}
	if state == nil {
		return nil // idempotent delete
	}

	return s.repository.DeleteState(ctx, id)
}
