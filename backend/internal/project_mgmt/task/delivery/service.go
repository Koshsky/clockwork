package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
)

type TaskService interface {
	ListTasks(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]dto.TaskResponse, int64, error)
	FindTask(ctx context.Context, id int64) (*dto.TaskResponse, error)
	CreateTask(ctx context.Context, task dto.CreateTaskRequest) (*dto.TaskResponse, error)
	DeleteTask(ctx context.Context, id int64) error
	UpdateTask(ctx context.Context, id int64, task dto.UpdateTaskRequest) (*dto.TaskResponse, error)
	ReorderTasks(ctx context.Context, req dto.ReorderTaskRequest) error
}
