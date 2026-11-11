package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository/sqlc"
)

// TaskDependencyRepository is the data access contract of the dependency
// service (implemented by repository.TaskDependencyRepository).
type TaskDependencyRepository interface {
	CreateDependency(ctx context.Context, taskID, dependsOnTaskID int64, typ string) (*sqlc.TaskDependency, error)
	ListDependenciesByTask(ctx context.Context, taskID int64) ([]sqlc.TaskDependency, error)
	FindDependency(ctx context.Context, id int64) (*sqlc.TaskDependency, error)
	UpdateDependencyType(ctx context.Context, id int64, typ string) (*sqlc.TaskDependency, error)
	DeleteDependency(ctx context.Context, id int64) error
	DependencyExists(ctx context.Context, taskID, dependsOnTaskID int64) (bool, error)
	ValidateLink(ctx context.Context, taskID, dependsOnTaskID int64) (sqlc.ValidateLinkRow, error)
	DependencyCycle(ctx context.Context, taskID, dependsOnTaskID int64) (bool, error)
	ListTaskConstraints(ctx context.Context, taskID int64) ([]sqlc.ListTaskConstraintsRow, error)
	FindTaskDates(ctx context.Context, taskID int64) (sqlc.FindTaskDatesRow, error)
}
