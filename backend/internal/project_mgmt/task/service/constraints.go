package service

import (
	"context"

	"github.com/Koshsky/erp-backend/pkg/date"
)

// ConstraintSource validates a task's dates against its incoming dependency
// links (the task as a successor). Implemented by the task_dependency service;
// injected via wire.Bind in the project_mgmt provider set.
type ConstraintSource interface {
	CheckTaskDates(ctx context.Context, taskID int64, taskTitle string, start, end date.Date) error
}
