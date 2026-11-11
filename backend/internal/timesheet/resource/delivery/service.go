package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/dto"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type ResourceService interface {
	ListResources(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]dto.ResourceResponse, int64, error)
	FindResource(ctx context.Context, id int64) (*dto.ResourceResponse, error)
	CreateResource(
		ctx context.Context,
		resource dto.CreateResourceRequest,
		userID int64,
	) (*dto.ResourceResponse, error)
	DeleteResource(ctx context.Context, id int64) error
	UpdateResource(
		ctx context.Context,
		id int64,
		resource dto.UpdateResourceRequest,
	) (*dto.ResourceResponse, error)
	ListMembers(ctx context.Context, resourceID int64) ([]dto.ResourceMemberResponse, error)
	AddMember(ctx context.Context, resourceID, userID, actorID int64, actorAdmin bool) error
	RemoveMember(ctx context.Context, resourceID, userID int64) error
	ListAbsence(
		ctx context.Context,
		resourceID int64,
		start, end date.Date,
	) ([]dto.ResourceAbsenceResponse, error)
}
