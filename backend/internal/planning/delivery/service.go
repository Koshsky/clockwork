package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/planning/dto"
)

type MilestoneService interface {
	GetProjectPlanning(ctx context.Context, userID int64, scope rbac.ListScope) (*dto.ProjectPlanning, error)
	GetProcessPlanning(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope, projectScope rbac.ListScope,
	) (*dto.ProcessPlanning, error)
	GetTaskPlanning(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope, resourceScope rbac.ListScope,
	) (*dto.TaskPlanning, error)
}
