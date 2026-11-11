package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type ResourceRepository interface {
	CreateResource(
		ctx context.Context,
		code, title string,
		color *string,
		ownerID *int64,
	) (*sqlc.ListResourcesRow, error)
	FindResource(ctx context.Context, id int64) (*sqlc.ListResourcesRow, error)
	UpdateResource(
		ctx context.Context,
		id int64,
		code, title string,
		color *string,
		ownerID *int64,
	) (*sqlc.ListResourcesRow, error)
	DeleteResource(ctx context.Context, id int64) error
	ListResources(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]sqlc.ListResourcesRow, error)
	CountResources(ctx context.Context, userID int64, scope rbac.ListScope, ownerID int64) (int64, error)
	ListResourcesByOwnerID(ctx context.Context, ownerID int64) ([]sqlc.ListResourcesRow, error)
	ListMembersByResourceID(ctx context.Context, resourceID int64) ([]sqlc.ListMembersByResourceIDRow, error)
	AddMember(ctx context.Context, resourceID, userID int64) error
	RemoveMember(ctx context.Context, resourceID, userID int64) error
	FindUserManager(ctx context.Context, userID int64) (*int64, error)
	ListAbsence(ctx context.Context, resourceID int64, start, end date.Date) ([]sqlc.ListResourceAbsenceRow, error)
}
