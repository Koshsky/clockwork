package service

import (
	"context"
	"log/slog"

	repo "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/dto"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type TaskDependencyService struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository TaskDependencyRepository
	mapper     *TaskDependencyMapper
	validator  *DependencyValidator
}

// NewTaskDependencyService builds the TaskDependencyService service.
func NewTaskDependencyService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r *repo.TaskDependencyRepository,
) *TaskDependencyService {
	return &TaskDependencyService{
		logger:     logger.With("component", "task_dependency_service"),
		tracer:     tracer,
		repository: r,
		mapper:     &TaskDependencyMapper{},
		validator:  &DependencyValidator{},
	}
}

// CreateDependency creates a scheduling link: taskID (the successor) depends
// on req.DependsOnTaskID (the predecessor) with the given type. The link must
// not close a cycle and the successor's current dates must already satisfy the
// new constraint.
func (s *TaskDependencyService) CreateDependency(
	ctx context.Context,
	taskID int64,
	req dto.CreateDependencyRequest,
) (*dto.DependencyResponse, error) {
	ctx, end := s.tracer.Start(ctx, "task_dependency.CreateDependency")
	defer end(nil)

	if err := s.validator.ValidateCreate(taskID, req.DependsOnTaskID, req.Type); err != nil {
		return nil, err
	}
	if taskID == req.DependsOnTaskID {
		return nil, errors.NewValidationError("задача не может зависеть от самой себя")
	}

	link, err := s.repository.ValidateLink(ctx, taskID, req.DependsOnTaskID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.NewValidationError("задача не найдена")
		}
		return nil, err
	}
	if link.PredID == 0 {
		return nil, errors.NewValidationError("предшественник не найден")
	}
	if link.TaskProcessID != link.PredProcessID {
		return nil, errors.NewValidationError("связи допустимы только между задачами одного процесса")
	}
	if !link.TaskIsTop || !link.PredIsTop {
		return nil, errors.NewValidationError("в связях участвуют только основные задачи (не операции)")
	}

	exists, err := s.repository.DependencyExists(ctx, taskID, req.DependsOnTaskID)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, errors.NewValidationError("такая связь уже существует")
	}

	cycle, err := s.repository.DependencyCycle(ctx, taskID, req.DependsOnTaskID)
	if err != nil {
		return nil, err
	}
	if cycle {
		return nil, errors.NewValidationError("связь создала бы цикл зависимостей")
	}

	// The successor's CURRENT dates must satisfy the new edge — a link that
	// contradicts the existing schedule cannot be stored.
	if err = checkConstraint(
		link.TaskTitle, link.TaskStartDate, link.TaskEndDate,
		req.Type, link.PredTitle, link.PredStartDate, link.PredEndDate,
	); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateDependency(ctx, taskID, req.DependsOnTaskID, req.Type)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTO(created), nil
}

// ListDependencies returns the predecessors (incoming links) of a task.
func (s *TaskDependencyService) ListDependencies(
	ctx context.Context,
	taskID int64,
) ([]dto.DependencyResponse, error) {
	ctx, end := s.tracer.Start(ctx, "task_dependency.ListDependencies")
	defer end(nil)

	if err := s.validator.ValidatePositiveID(taskID, "task_id"); err != nil {
		return nil, err
	}
	rows, err := s.repository.ListDependenciesByTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTOs(rows), nil
}

// UpdateDependencyType changes the type of an existing link. The new type must
// not contradict the successor's current dates.
func (s *TaskDependencyService) UpdateDependencyType(
	ctx context.Context,
	taskID, depID int64,
	req dto.UpdateDependencyRequest,
) (*dto.DependencyResponse, error) {
	ctx, end := s.tracer.Start(ctx, "task_dependency.UpdateDependencyType")
	defer end(nil)

	if err := s.validator.ValidateTypeUpdate(req.Type); err != nil {
		return nil, err
	}

	dep, err := s.repository.FindDependency(ctx, depID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.NotFound("связь не найдена")
		}
		return nil, err
	}
	if dep.TaskID != taskID {
		return nil, errors.NewValidationError("связь не принадлежит этой задаче")
	}

	if dep.Type != req.Type {
		if err = s.checkDateChange(ctx, taskID, depID, req.Type); err != nil {
			return nil, err
		}
	}

	updated, err := s.repository.UpdateDependencyType(ctx, depID, req.Type)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTO(updated), nil
}

// DeleteDependency removes a link (idempotent: an already-removed link is not
// an error; a link of another task is rejected).
func (s *TaskDependencyService) DeleteDependency(ctx context.Context, taskID, depID int64) error {
	ctx, end := s.tracer.Start(ctx, "task_dependency.DeleteDependency")
	defer end(nil)

	dep, err := s.repository.FindDependency(ctx, depID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete
		}
		return err
	}
	if dep.TaskID != taskID {
		return errors.NewValidationError("связь не принадлежит этой задаче")
	}
	return s.repository.DeleteDependency(ctx, depID)
}

// CheckTaskDates validates a task's NEW dates against all its incoming links
// (the task as a successor). Called by the task service on every date change
// so no write can persist a schedule that violates the dependencies.
func (s *TaskDependencyService) CheckTaskDates(
	ctx context.Context,
	taskID int64,
	taskTitle string,
	start, end date.Date,
) error {
	ctx, endSpan := s.tracer.Start(ctx, "task_dependency.CheckTaskDates")
	defer endSpan(nil)

	constraints, err := s.repository.ListTaskConstraints(ctx, taskID)
	if err != nil {
		return err
	}
	for i := range constraints {
		c := &constraints[i]
		if err = checkConstraint(
			taskTitle, start, end,
			c.Type, c.PredTitle, c.PredStartDate, c.PredEndDate,
		); err != nil {
			return err
		}
	}
	return nil
}

// checkDateChange validates the successor's current dates against all its
// incoming links, substituting newType on the target link (used by a type
// change, where the other links stay as stored).
func (s *TaskDependencyService) checkDateChange(
	ctx context.Context,
	taskID, depID int64,
	newType string,
) error {
	constraints, err := s.repository.ListTaskConstraints(ctx, taskID)
	if err != nil {
		return err
	}
	dates, err := s.repository.FindTaskDates(ctx, taskID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return errors.NotFound("задача не найдена")
		}
		return err
	}
	for i := range constraints {
		c := &constraints[i]
		typ := c.Type
		if c.ID == depID {
			typ = newType
		}
		if err = checkConstraint(
			"", dates.StartDate, dates.EndDate,
			typ, c.PredTitle, c.PredStartDate, c.PredEndDate,
		); err != nil {
			return err
		}
	}
	return nil
}
