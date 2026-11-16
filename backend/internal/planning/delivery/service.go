package delivery

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/planning/dto"
)

type MilestoneService interface {
	GetProjectPlanning(ctx context.Context, userID int64, scope access.ListScope) (*dto.ProjectPlanning, error)
	GetProcessPlanning(
		ctx context.Context,
		userID int64,
		scope access.ListScope, projectScope access.ListScope,
	) (*dto.ProcessPlanning, error)
	GetTaskPlanning(
		ctx context.Context,
		userID int64,
		scope access.ListScope, resourceScope access.ListScope,
	) (*dto.TaskPlanning, error)
}
