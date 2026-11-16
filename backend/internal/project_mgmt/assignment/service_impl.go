package assignment

import (
	"context"
	"log/slog"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/dto"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type Service struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository Repository
	mapper     *Mapper
	validator  *Validator
}

// NewService builds the assignment service.
func NewService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r Repository,
) *Service {
	return &Service{
		logger:     logger.With("component", "assignment_service"),
		tracer:     tracer,
		repository: r,
		mapper:     NewMapper(),
		validator:  &Validator{},
	}
}

func (s *Service) CreateAssignment(
	ctx context.Context,
	req dto.CreateAssignmentRequest,
) (*dto.AssignmentResponse, error) {
	ctx, end := s.tracer.Start(ctx, "assignment.CreateAssignment")
	defer end(nil)

	if err := s.validator.ValidateAssignment(req.TaskID, req.ResourceID, req.Quantity); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateAssignment(ctx, req.TaskID, req.ResourceID, req.Quantity)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(created), nil
}

func (s *Service) FindAssignment(ctx context.Context, id int64) (*dto.AssignmentResponse, error) {
	ctx, end := s.tracer.Start(ctx, "assignment.FindAssignment")
	defer end(nil)

	assignment, err := s.repository.FindAssignment(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.ErrAssignmentNotFound
		}
		return nil, err
	}
	if assignment == nil {
		return nil, errors.ErrAssignmentNotFound
	}
	return s.mapper.ToDTO(assignment), nil
}

func (s *Service) UpdateAssignment(
	ctx context.Context,
	id int64,
	req dto.UpdateAssignmentRequest,
) (*dto.AssignmentResponse, error) {
	ctx, end := s.tracer.Start(ctx, "assignment.UpdateAssignment")
	defer end(nil)

	assignment, err := s.repository.FindAssignment(ctx, id)
	if err != nil || assignment == nil {
		return nil, errors.ErrAssignmentNotFound
	}

	if req.TaskID != nil {
		assignment.TaskID = *req.TaskID
	}
	if req.ResourceID != nil {
		assignment.ResourceID = *req.ResourceID
	}
	quantity := int(assignment.Quantity)
	if req.Quantity != nil {
		quantity = *req.Quantity
	}
	if err = s.validator.ValidateAssignment(assignment.TaskID, assignment.ResourceID, quantity); err != nil {
		return nil, err
	}

	updated, err := s.repository.UpdateAssignment(ctx, *assignment, quantity)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(updated), nil
}

func (s *Service) DeleteAssignment(ctx context.Context, id int64) error {
	ctx, end := s.tracer.Start(ctx, "assignment.DeleteAssignment")
	defer end(nil)

	assignment, err := s.repository.FindAssignment(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete: already deleted — not an error
		}
		return err
	}
	if assignment == nil {
		return nil // idempotent delete
	}

	return s.repository.DeleteAssignment(ctx, id)
}

func (s *Service) ListAssignments(
	ctx context.Context,
	userID int64,
	scope access.ListScope,
	ownerID int64,
	limit, offset int,
) ([]dto.AssignmentResponse, int64, error) {
	ctx, end := s.tracer.Start(ctx, "assignment.ListAssignments")
	defer end(nil)

	rows, err := s.repository.ListAssignments(ctx, userID, scope, ownerID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repository.CountAssignments(ctx, userID, scope, ownerID)
	if err != nil {
		return nil, 0, err
	}
	return s.mapper.ToDTOs(rows), total, nil
}
