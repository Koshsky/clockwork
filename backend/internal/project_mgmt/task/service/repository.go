package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
)

type TaskRepository interface {
	CreateTask(ctx context.Context, task sqlc.Task) (*sqlc.Task, error)
	FindTask(ctx context.Context, id int64) (*sqlc.Task, error)
	UpdateTask(ctx context.Context, task sqlc.Task) (*sqlc.Task, error)
	DeleteTask(ctx context.Context, id int64) error
	ListTasks(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]sqlc.Task, error)
	CountTasks(ctx context.Context, userID int64, scope rbac.ListScope, ownerID int64) (int64, error)
	ListTaskIDsByProcess(ctx context.Context, processID int64) ([]int64, error)
	ReorderTasks(ctx context.Context, ids []int64) error
}
