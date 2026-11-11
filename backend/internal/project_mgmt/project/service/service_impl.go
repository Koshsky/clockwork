package service

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	repo "github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/dto"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type ProjectService struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository ProjectRepository
	mapper     *ProjectMapper
	validator  *ProjectValidator
}

// NewProjectService builds the ProjectService service.
func NewProjectService(logger *slog.Logger, tracer *tracingpkg.Tracer, r *repo.ProjectRepository) *ProjectService {
	return &ProjectService{
		logger:     logger.With("component", "project_service"),
		tracer:     tracer,
		repository: r,
		mapper:     NewProjectMapper(),
		validator:  &ProjectValidator{},
	}
}

// CreateProject creates a project. The middleware checked permissions; here
// only owner normalization: a caller creating into own ownership (own scope)
// always becomes the owner (forceSelfOwner). The response also reports what
// the auto-create template (DB trigger V8) added to the project.
func (s *ProjectService) CreateProject(
	ctx context.Context,
	req dto.CreateProjectRequest,
	userID int64,
	forceSelfOwner bool,
) (*dto.CreateProjectResponse, error) {
	ctx, end := s.tracer.Start(ctx, "project.CreateProject")
	defer end(nil)

	if forceSelfOwner {
		// the owner-scoped creator immediately becomes the owner; a foreign owner from the request is ignored
		req.OwnerID = &userID
	}

	if err := s.validator.ValidateProject(
		req.Code,
		req.Color,
		req.Priority,
		req.StartDate,
		req.EndDate,
	); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateProject(
		ctx,
		req.OwnerID,
		req.ResponsibleID,
		req.Code,
		req.Color,
		req.StartDate,
		req.EndDate,
		req.Priority,
	)
	if err != nil {
		return nil, err
	}

	counts, err := s.repository.AutoCreatedCounts(ctx, created.ID)
	if err != nil {
		// Non-critical feedback: the project itself was created fine.
		s.logger.WarnContext(ctx, "auto-create counts unavailable", "project_id", created.ID, "error", err)
	}
	return s.mapper.ToCreateDTO(created, counts), nil
}

func (s *ProjectService) FindProject(ctx context.Context, id int64) (*dto.ProjectResponse, error) {
	ctx, end := s.tracer.Start(ctx, "project.FindProject")
	defer end(nil)

	project, err := s.repository.FindProject(ctx, id)
	if err != nil {
		return nil, err
	}
	if project == nil {
		return nil, errors.ErrProjectNotFound
	}
	return s.mapper.ToDTO(project), nil
}

// UpdateProject changes code, dates, priority and owner. Permissions (priority
// vs other fields, owner change admin-only) are checked by the middleware
// against the request body.
func (s *ProjectService) UpdateProject(
	ctx context.Context,
	id int64,
	req dto.UpdateProjectRequest,
) (*dto.ProjectResponse, error) {
	ctx, end := s.tracer.Start(ctx, "project.UpdateProject")
	defer end(nil)

	project, err := s.repository.FindProject(ctx, id)
	if err != nil || project == nil {
		return nil, errors.ErrProjectNotFound
	}

	if req.OwnerID != nil {
		project.OwnerID = nullable.ToInt8(req.OwnerID)
	}
	if req.ResponsibleID != nil {
		// 0 is the "clear" sentinel (never a valid user id) — reset to NULL.
		if *req.ResponsibleID == 0 {
			project.ResponsibleID = pgtype.Int8{}
		} else {
			project.ResponsibleID = nullable.ToInt8(req.ResponsibleID)
		}
	}
	if req.Code != nil {
		project.Code = *req.Code
	}
	if req.Color != nil {
		if *req.Color == "" {
			project.Color = sql.NullString{}
		} else {
			project.Color = sql.NullString{String: *req.Color, Valid: true}
		}
	}
	if req.StartDate != nil {
		project.StartDate = *req.StartDate
	}
	if req.EndDate != nil {
		project.EndDate = *req.EndDate
	}
	priority := int(project.Priority)
	if req.Priority != nil {
		priority = *req.Priority
	}
	if err = s.validator.ValidateProject(
		project.Code,
		nullable.StringPtr(project.Color),
		priority,
		project.StartDate,
		project.EndDate,
	); err != nil {
		return nil, err
	}

	updated, err := s.repository.UpdateProject(ctx, *project, priority)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(updated), nil
}

func (s *ProjectService) DeleteProject(ctx context.Context, id int64) error {
	ctx, end := s.tracer.Start(ctx, "project.DeleteProject")
	defer end(nil)

	project, err := s.repository.FindProject(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete: already deleted — not an error
		}
		return err
	}
	if project == nil {
		return nil // idempotent delete
	}

	return s.repository.DeleteProject(ctx, id)
}

func (s *ProjectService) ListProjects(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]dto.ProjectResponse, int64, error) {
	ctx, end := s.tracer.Start(ctx, "project.ListProjects")
	defer end(nil)

	rows, err := s.repository.ListProjects(ctx, userID, scope, ownerID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repository.CountProjects(ctx, userID, scope, ownerID)
	if err != nil {
		return nil, 0, err
	}
	return s.mapper.ToDTOs(rows), total, nil
}
