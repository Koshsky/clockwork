//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	errapi "github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository/sqlc"
)

type TaskDependencyRepository struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	db     *sqlc.Queries
}

// NewTaskDependencyRepository builds the TaskDependencyRepository repository.
func NewTaskDependencyRepository(logger *slog.Logger, pool *pgxpool.Pool) *TaskDependencyRepository {
	return &TaskDependencyRepository{
		logger: logger.With("component", "task_dependency_repository"),
		pool:   pool,
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *TaskDependencyRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

// CreateDependency inserts a dependency edge (task_id depends on
// depends_on_task_id).
func (r *TaskDependencyRepository) CreateDependency(
	ctx context.Context,
	taskID, dependsOnTaskID int64,
	typ string,
) (*sqlc.TaskDependency, error) {
	row, err := r.q(ctx).CreateDependency(ctx, sqlc.CreateDependencyParams{
		TaskID:          taskID,
		DependsOnTaskID: dependsOnTaskID,
		Type:            typ,
	})
	if err != nil {
		return nil, errapi.MapPgConstraint(errapi.FromPgInvalidParam(err))
	}
	return &row, nil
}

// ListDependenciesByTask returns the predecessors (incoming links) of a task,
// in creation order.
func (r *TaskDependencyRepository) ListDependenciesByTask(
	ctx context.Context,
	taskID int64,
) ([]sqlc.TaskDependency, error) {
	return r.q(ctx).ListDependenciesByTask(ctx, taskID)
}

// FindDependency returns a dependency edge by its id.
func (r *TaskDependencyRepository) FindDependency(
	ctx context.Context,
	id int64,
) (*sqlc.TaskDependency, error) {
	row, err := r.q(ctx).FindDependency(ctx, id)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// UpdateDependencyType rewrites the type of a dependency edge.
func (r *TaskDependencyRepository) UpdateDependencyType(
	ctx context.Context,
	id int64,
	typ string,
) (*sqlc.TaskDependency, error) {
	row, err := r.q(ctx).UpdateDependencyType(ctx, sqlc.UpdateDependencyTypeParams{
		ID:   id,
		Type: typ,
	})
	if err != nil {
		return nil, errapi.MapPgConstraint(errapi.FromPgInvalidParam(err))
	}
	return &row, nil
}

// DeleteDependency removes a dependency edge (archived by trigger).
func (r *TaskDependencyRepository) DeleteDependency(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteDependency(ctx, id)
}

// DependencyExists reports whether the exact edge (task_id -> depends_on) is
// already stored.
func (r *TaskDependencyRepository) DependencyExists(
	ctx context.Context,
	taskID, dependsOnTaskID int64,
) (bool, error) {
	return r.q(ctx).DependencyExists(ctx, sqlc.DependencyExistsParams{
		TaskID:          taskID,
		DependsOnTaskID: dependsOnTaskID,
	})
}

// ValidateLink returns both endpoints of a candidate dependency (the
// dependent task keyed by task_id; pred_id 0 — the predecessor is missing)
// with the dates/parent/process info for the service checks.
func (r *TaskDependencyRepository) ValidateLink(
	ctx context.Context,
	taskID, dependsOnTaskID int64,
) (sqlc.ValidateLinkRow, error) {
	return r.q(ctx).ValidateLink(ctx, sqlc.ValidateLinkParams{
		TaskID:          taskID,
		DependsOnTaskID: dependsOnTaskID,
	})
}

// DependencyCycle reports whether adding task_id -> depends_on_task_id would
// close a cycle (the predecessor already transitively depends on the task).
func (r *TaskDependencyRepository) DependencyCycle(
	ctx context.Context,
	taskID, dependsOnTaskID int64,
) (bool, error) {
	return r.q(ctx).DependencyCycle(ctx, sqlc.DependencyCycleParams{
		TaskID:          taskID,
		DependsOnTaskID: dependsOnTaskID,
	})
}

// ListTaskConstraints returns the incoming scheduling constraints of a task
// (the task as a successor) with the predecessors' current dates.
func (r *TaskDependencyRepository) ListTaskConstraints(
	ctx context.Context,
	taskID int64,
) ([]sqlc.ListTaskConstraintsRow, error) {
	return r.q(ctx).ListTaskConstraints(ctx, taskID)
}

// FindTaskDates returns the current dates of a task.
func (r *TaskDependencyRepository) FindTaskDates(
	ctx context.Context,
	taskID int64,
) (sqlc.FindTaskDatesRow, error) {
	return r.q(ctx).FindTaskDates(ctx, taskID)
}
