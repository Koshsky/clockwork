package task

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
)

type Repository interface {
	CreateTask(ctx context.Context, task sqlc.Task) (*sqlc.Task, error)
	FindTask(ctx context.Context, id int64) (*sqlc.Task, error)
	UpdateTask(ctx context.Context, task sqlc.Task) (*sqlc.Task, error)
	DeleteTask(ctx context.Context, id int64) error
	ListTasks(
		ctx context.Context,
		userID int64,
		scope access.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]sqlc.Task, error)
	CountTasks(ctx context.Context, userID int64, scope access.ListScope, ownerID int64) (int64, error)
	ListTaskIDsByProcess(ctx context.Context, processID int64) ([]int64, error)
	ReorderTasks(ctx context.Context, ids []int64) error
}
