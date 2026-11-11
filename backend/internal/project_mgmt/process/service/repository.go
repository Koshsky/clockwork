package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type ProcessRepository interface {
	CreateProcess(
		ctx context.Context,
		projectID int64,
		title string,
		color *string,
		ownerID *int64,
		responsibleID *int64,
		startDate, endDate date.Date,
	) (*sqlc.Process, error)
	FindProcess(ctx context.Context, id int64) (*sqlc.Process, error)
	UpdateProcess(ctx context.Context, process sqlc.Process) (*sqlc.Process, error)
	DeleteProcess(ctx context.Context, id int64) error
	ListProcesss(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]sqlc.Process, error)
	CountProcesses(ctx context.Context, userID int64, scope rbac.ListScope, ownerID int64) (int64, error)
	ListProcessIDsByProject(ctx context.Context, projectID int64) ([]int64, error)
	ReorderProcesses(ctx context.Context, ids []int64) error
}
