//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	errapi "github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type TaskRepository struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	db     *sqlc.Queries
}

// NewTaskRepository builds the TaskRepository repository.
func NewTaskRepository(logger *slog.Logger, pool *pgxpool.Pool) *TaskRepository {
	return &TaskRepository{
		logger: logger.With("component", "task_repository"),
		pool:   pool,
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *TaskRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *TaskRepository) CreateTask(ctx context.Context, task sqlc.Task) (*sqlc.Task, error) {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return nil, err
	}
	if owned {
		defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	}
	q := r.db.WithTx(tx)
	if err = q.LockTaskAppendOrder(ctx); err != nil {
		return nil, err
	}
	row, err := q.CreateTask(ctx, sqlc.CreateTaskParams{
		ProcessID: task.ProcessID,
		// 0 means "no parent" (the query NULLIFs it to NULL); the real parent
		// id for subtasks. Both map to the same NULLIF branch in the INSERT.
		ParentID:      nullable.PtrValueOr(nullable.Int64Ptr(task.ParentID), 0),
		OwnerID:       task.OwnerID,
		ResponsibleID: task.ResponsibleID,
		Title:         task.Title,
		Color:         task.Color,
		Status:        task.Status,
		StartDate:     task.StartDate,
		EndDate:       task.EndDate,
	})
	if err != nil {
		return nil, errapi.MapPgConstraint(errapi.FromPgInvalidParam(err))
	}
	if owned {
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
	}

	return &row, nil
}

func (r *TaskRepository) FindTask(ctx context.Context, id int64) (*sqlc.Task, error) {
	row, err := r.q(ctx).FindTask(ctx, id)
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *TaskRepository) UpdateTask(ctx context.Context, task sqlc.Task) (*sqlc.Task, error) {
	row, err := r.q(ctx).UpdateTask(ctx, sqlc.UpdateTaskParams{
		TaskID:        task.ID,
		OwnerID:       task.OwnerID,
		ResponsibleID: task.ResponsibleID,
		Title:         task.Title,
		Color:         task.Color,
		Status:        task.Status,
		StartDate:     task.StartDate,
		EndDate:       task.EndDate,
	})
	if err != nil {
		return nil, errapi.MapPgConstraint(errapi.FromPgInvalidParam(err))
	}

	return &row, nil
}

func (r *TaskRepository) DeleteTask(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteTask(ctx, id)
}

func (r *TaskRepository) ListTasks(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]sqlc.Task, error) {
	return r.q(ctx).ListTasks(ctx, sqlc.ListTasksParams{
		ScAll:          scope.All,
		ScSelf:         scope.Self,
		UserID:         userID,
		ScParent:       scope.Parent,
		ScAncestor:     scope.Ancestor,
		ScSib:          scope.Sib,
		ScProjectSib:   scope.ProjectSib,
		ScDown:         scope.Down,
		ScNone:         scope.None,
		OwnerID:        ownerID,
		PageLimit:      int64(limit),
		PageOffset:     int64(offset),
		ScProjectOwner: scope.ProjectOwner,
		ScProcessOwner: scope.ProcessOwner,
		ProjectView:    scope.ProjectView,
		ProcessView:    scope.ProcessView,
	})
}

func (r *TaskRepository) CountTasks(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
) (int64, error) {
	return r.q(ctx).CountTasks(
		ctx,
		sqlc.CountTasksParams{
			ScAll:          scope.All,
			ScSelf:         scope.Self,
			UserID:         userID,
			ScParent:       scope.Parent,
			ScAncestor:     scope.Ancestor,
			ScSib:          scope.Sib,
			ScProjectSib:   scope.ProjectSib,
			ScDown:         scope.Down,
			ScNone:         scope.None,
			OwnerID:        ownerID,
			ScProjectOwner: scope.ProjectOwner,
			ScProcessOwner: scope.ProcessOwner,
			ProjectView:    scope.ProjectView,
			ProcessView:    scope.ProcessView,
		},
	)
}

// ListSubtasksByParent returns the active subtasks of a task in display order.
func (r *TaskRepository) ListSubtasksByParent(ctx context.Context, parentID int64) ([]sqlc.Task, error) {
	return r.q(ctx).ListSubtasksByParent(ctx, parentID)
}

// ListTaskIDsByProcess returns the active task ids of a process in their
// display order — to validate a reorder request covers the whole group.
func (r *TaskRepository) ListTaskIDsByProcess(ctx context.Context, processID int64) ([]int64, error) {
	return r.q(ctx).ListTaskIdsByProcess(ctx, processID)
}

// ReorderTasks rewrites the sort_order of the given task ids by list position
// (1-based) in one transaction. The caller validates that the ids cover the
// whole group. The two-phase UPDATE parks the rows on offset slots first,
// because a single-statement value swap would transiently violate the partial
// unique index (process_id, sort_order).
func (r *TaskRepository) ReorderTasks(ctx context.Context, ids []int64) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = r.db.WithTx(tx)
	}
	if err = q.ReorderTasksMark(ctx, ids); err != nil {
		return err
	}
	if err = q.ReorderTasksApply(ctx, ids); err != nil {
		return err
	}
	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// OwnerChain returns the owner chain (for RBAC checks in the middleware).
func (r *TaskRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	row, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{ProjectOwner: row.ProjectOwner, ProcessOwner: row.ProcessOwner, Owner: row.OwnerID}, nil
}
