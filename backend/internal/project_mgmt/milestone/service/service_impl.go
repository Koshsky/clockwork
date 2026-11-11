package service

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"

	repo "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/repository"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/dto"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type MilestoneService struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository MilestoneRepository
	mapper     *MilestoneMapper
	validator  *MilestoneValidator
}

// NewMilestoneService builds the MilestoneService service.
func NewMilestoneService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r *repo.MilestoneRepository,
) *MilestoneService {
	return &MilestoneService{
		logger:     logger.With("component", "milestone_service"),
		tracer:     tracer,
		repository: r,
		mapper:     NewMilestoneMapper(),
		validator:  &MilestoneValidator{},
	}
}

func (s *MilestoneService) CreateMilestone(
	ctx context.Context,
	req dto.CreateMilestoneRequest,
) (*dto.MilestoneResponse, error) {
	ctx, end := s.tracer.Start(ctx, "milestone.CreateMilestone")
	defer end(nil)

	if err := s.validator.ValidateMilestone(
		req.ProcessID,
		req.Title,
		req.Content,
		req.Color,
		req.Date,
	); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateMilestone(ctx, req.ProcessID, req.Title, req.Content, req.Color, req.Date)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(created), nil
}

func (s *MilestoneService) FindMilestone(ctx context.Context, id int64) (*dto.MilestoneResponse, error) {
	ctx, end := s.tracer.Start(ctx, "milestone.FindMilestone")
	defer end(nil)

	milestone, err := s.repository.FindMilestone(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.ErrMilestoneNotFound
		}
		return nil, err
	}
	if milestone == nil {
		return nil, errors.ErrMilestoneNotFound
	}
	return s.mapper.ToDTO(milestone), nil
}

func (s *MilestoneService) UpdateMilestone(
	ctx context.Context,
	id int64,
	req dto.UpdateMilestoneRequest,
) (*dto.MilestoneResponse, error) {
	ctx, end := s.tracer.Start(ctx, "milestone.UpdateMilestone")
	defer end(nil)

	milestone, err := s.repository.FindMilestone(ctx, id)
	if err != nil || milestone == nil {
		return nil, errors.ErrMilestoneNotFound
	}

	if req.Title != nil {
		milestone.Title = *req.Title
	}
	if req.Content != nil {
		milestone.Content = *req.Content
	}
	if req.Color != nil {
		if *req.Color == "" {
			milestone.Color = sql.NullString{}
		} else {
			milestone.Color = sql.NullString{String: *req.Color, Valid: true}
		}
	}
	if req.Date != nil {
		milestone.Date = *req.Date
	}
	if req.ProcessID != nil {
		milestone.ProcessID = *req.ProcessID
	}
	if err = s.validator.ValidateMilestone(
		milestone.ProcessID,
		milestone.Title,
		milestone.Content,
		nullable.StringPtr(milestone.Color),
		milestone.Date,
	); err != nil {
		return nil, err
	}

	updated, err := s.repository.UpdateMilestone(ctx, *milestone)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(updated), nil
}

func (s *MilestoneService) DeleteMilestone(ctx context.Context, id int64) error {
	ctx, end := s.tracer.Start(ctx, "milestone.DeleteMilestone")
	defer end(nil)

	milestone, err := s.repository.FindMilestone(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete: already deleted — not an error
		}
		return err
	}
	if milestone == nil {
		return nil // idempotent delete
	}

	return s.repository.DeleteMilestone(ctx, id)
}

func (s *MilestoneService) ListMilestones(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]dto.MilestoneResponse, int64, error) {
	ctx, end := s.tracer.Start(ctx, "milestone.ListMilestones")
	defer end(nil)

	rows, err := s.repository.ListMilestones(ctx, userID, scope, ownerID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repository.CountMilestones(ctx, userID, scope, ownerID)
	if err != nil {
		return nil, 0, err
	}
	return s.mapper.ToDTOs(rows), total, nil
}
