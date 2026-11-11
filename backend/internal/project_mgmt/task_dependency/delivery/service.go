package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/dto"
	"github.com/Koshsky/erp-backend/pkg/date"
)

// TaskDependencyService is the handler's view of the dependency service.
type TaskDependencyService interface {
	ListDependencies(ctx context.Context, taskID int64) ([]dto.DependencyResponse, error)
	CreateDependency(
		ctx context.Context,
		taskID int64,
		req dto.CreateDependencyRequest,
	) (*dto.DependencyResponse, error)
	UpdateDependencyType(
		ctx context.Context,
		taskID, depID int64,
		req dto.UpdateDependencyRequest,
	) (*dto.DependencyResponse, error)
	DeleteDependency(ctx context.Context, taskID, depID int64) error
	CheckTaskDates(ctx context.Context, taskID int64, taskTitle string, start, end date.Date) error
}
