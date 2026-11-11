package service

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/order"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/domain"
	repo "github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type TaskService struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository TaskRepository
	mapper     *TaskMapper
	validator  *TaskValidator
	deps       ConstraintSource
}

// NewTaskService builds the TaskService service.
func NewTaskService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r *repo.TaskRepository,
	deps ConstraintSource,
) *TaskService {
	return &TaskService{
		logger:     logger.With("component", "task_service"),
		tracer:     tracer,
		repository: r,
		mapper:     &TaskMapper{},
		validator:  &TaskValidator{},
		deps:       deps,
	}
}

func (s *TaskService) CreateTask(ctx context.Context, req dto.CreateTaskRequest) (*dto.TaskResponse, error) {
	ctx, end := s.tracer.Start(ctx, "task.CreateTask")
	defer end(nil)

	status := domain.StatusNotStarted
	if req.Status != nil && *req.Status != "" {
		status = *req.Status
	}

	task := sqlc.Task{
		ProcessID:     req.ProcessID,
		ParentID:      nullable.ToInt8(req.ParentID),
		OwnerID:       nullable.ToInt8(req.OwnerID),
		ResponsibleID: nullable.ToInt8(req.ResponsibleID),
		Title:         req.Title,
		Color:         nullable.ToString(req.Color),
		Status:        status,
		StartDate:     dateFromPtr(req.StartDate),
		EndDate:       dateFromPtr(req.EndDate),
	}
	if err := s.validator.ValidateTask(
		task.ProcessID,
		task.Title,
		nullable.StringPtr(task.Color),
		task.Status,
		req.ParentID,
		task.StartDate,
		task.EndDate,
	); err != nil {
		return nil, err
	}

	// Subtask (operation) semantics:
	//  - the parent must be a top-level task (a subtask cannot be a parent);
	//  - process_id always equals the parent's process (RBAC unchanged);
	//  - dates inherit the parent's bounds (subtask spans the parent's
	//    interval; the frontend never renders subtask dates).
	if err := s.applyParent(ctx, &task, req.ParentID); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateTask(ctx, task)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(created), nil
}

// dateFromPtr converts a nullable request date; a nil pointer yields the empty
// calendar date (subtask dates are inherited from the parent by the service).
func dateFromPtr(d *date.Date) date.Date {
	if d == nil {
		return ""
	}
	return *d
}

// applyParent resolves the parent for a subtask request: inherits the
// parent's process and dates and rejects a parent that is itself a subtask.
func (s *TaskService) applyParent(ctx context.Context, task *sqlc.Task, parentID *int64) error {
	if parentID == nil {
		return nil
	}
	parent, err := s.repository.FindTask(ctx, *parentID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return errors.NewValidationError("родительская задача не найдена")
		}
		return err
	}
	if parent == nil {
		return errors.NewValidationError("родительская задача не найдена")
	}
	if parent.ParentID.Valid {
		return errors.NewValidationError("подзадача не может иметь собственные подзадачи")
	}
	if task.ProcessID != parent.ProcessID {
		return errors.NewFieldError("process_id", "parent_mismatch", "subtask process must match parent task process")
	}
	task.StartDate = parent.StartDate
	task.EndDate = parent.EndDate
	return nil
}

func (s *TaskService) FindTask(ctx context.Context, id int64) (*dto.TaskResponse, error) {
	ctx, end := s.tracer.Start(ctx, "task.FindTask")
	defer end(nil)

	task, err := s.repository.FindTask(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.ErrTaskNotFound
		}
		return nil, err
	}
	if task == nil {
		return nil, errors.ErrTaskNotFound
	}
	return s.mapper.ToDTO(task), nil
}

func (s *TaskService) UpdateTask(ctx context.Context, id int64, req dto.UpdateTaskRequest) (*dto.TaskResponse, error) {
	ctx, end := s.tracer.Start(ctx, "task.UpdateTask")
	defer end(nil)

	task, err := s.repository.FindTask(ctx, id)
	if err != nil || task == nil {
		return nil, errors.ErrTaskNotFound
	}

	if req.OwnerID != nil {
		task.OwnerID = nullable.ToInt8(req.OwnerID)
	}
	if req.ResponsibleID != nil {
		// 0 is the "clear" sentinel (never a valid user id) — reset to NULL.
		if *req.ResponsibleID == 0 {
			task.ResponsibleID = pgtype.Int8{}
		} else {
			task.ResponsibleID = nullable.ToInt8(req.ResponsibleID)
		}
	}
	if req.Title != nil {
		task.Title = *req.Title
	}
	if req.Color != nil {
		if *req.Color == "" {
			task.Color = sql.NullString{}
		} else {
			task.Color = sql.NullString{String: *req.Color, Valid: true}
		}
	}
	if req.Status != nil {
		task.Status = *req.Status
	}
	if req.StartDate != nil {
		task.StartDate = *req.StartDate
	}
	if req.EndDate != nil {
		task.EndDate = *req.EndDate
	}

	// Schedule guard: when the dates change, the new interval must satisfy all
	// incoming dependency links (the task's own bound from each predecessor).
	// The frontend cascade keeps the successors in sync; this guard makes the
	// invariant authoritative for every write path.
	if err = s.checkUpdatedTaskDates(ctx, id, task, req); err != nil {
		return nil, err
	}

	if err = s.validator.ValidateTask(
		task.ProcessID,
		task.Title,
		nullable.StringPtr(task.Color),
		task.Status,
		nullable.Int64Ptr(task.ParentID),
		task.StartDate,
		task.EndDate,
	); err != nil {
		return nil, err
	}

	updated, err := s.repository.UpdateTask(ctx, *task)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(updated), nil
}

func (s *TaskService) checkUpdatedTaskDates(
	ctx context.Context,
	id int64,
	task *sqlc.Task,
	req dto.UpdateTaskRequest,
) error {
	if s.deps == nil || (req.StartDate == nil && req.EndDate == nil) {
		return nil
	}
	return s.deps.CheckTaskDates(ctx, id, task.Title, task.StartDate, task.EndDate)
}

func (s *TaskService) DeleteTask(ctx context.Context, id int64) error {
	ctx, end := s.tracer.Start(ctx, "task.DeleteTask")
	defer end(nil)

	task, err := s.repository.FindTask(ctx, id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete: already deleted — not an error
		}
		return err
	}
	if task == nil {
		return nil // idempotent delete
	}

	return s.repository.DeleteTask(ctx, id)
}

func (s *TaskService) ListTasks(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]dto.TaskResponse, int64, error) {
	ctx, end := s.tracer.Start(ctx, "task.ListTasks")
	defer end(nil)

	rows, err := s.repository.ListTasks(ctx, userID, scope, ownerID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repository.CountTasks(ctx, userID, scope, ownerID)
	if err != nil {
		return nil, 0, err
	}
	return s.mapper.ToDTOs(rows), total, nil
}

// ReorderTasks applies a new order to all active tasks of a process: the
// request carries the complete ordered id list, the server validates it covers
// the whole group and rewrites sort_order by list position.
func (s *TaskService) ReorderTasks(
	ctx context.Context,
	req dto.ReorderTaskRequest,
) error {
	ctx, end := s.tracer.Start(ctx, "task.ReorderTasks")
	defer end(nil)

	if len(req.IDs) == 0 {
		return errors.NewValidationError("список id задач пуст")
	}
	if err := order.RejectDuplicateIDs("задач", req.IDs); err != nil {
		return err
	}

	current, err := s.repository.ListTaskIDsByProcess(ctx, req.ProcessID)
	if err != nil {
		return err
	}
	if !order.SameIDSet(req.IDs, current) {
		return errors.NewValidationError(
			"список должен содержать все активные задачи процесса без изменений состава",
		)
	}

	return s.repository.ReorderTasks(ctx, req.IDs)
}
