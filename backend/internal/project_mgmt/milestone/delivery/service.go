package delivery

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/dto"
)

type MilestoneService interface {
	ListMilestones(
		ctx context.Context,
		userID int64,
		scope access.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]dto.MilestoneResponse, int64, error)
	FindMilestone(ctx context.Context, id int64) (*dto.MilestoneResponse, error)
	CreateMilestone(ctx context.Context, milestone dto.CreateMilestoneRequest) (*dto.MilestoneResponse, error)
	DeleteMilestone(ctx context.Context, id int64) error
	UpdateMilestone(ctx context.Context, id int64, milestone dto.UpdateMilestoneRequest) (*dto.MilestoneResponse, error)
}
