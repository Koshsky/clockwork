package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type UserRepository interface {
	CreateUser(ctx context.Context, user sqlc.User) (*sqlc.User, error)
	// CreateUserWithPermissions creates the account and its individual
	// permission overrides atomically.
	CreateUserWithPermissions(
		ctx context.Context,
		user sqlc.User,
		perms []domain.UserPermission,
		updatedBy int64,
	) (*sqlc.User, error)
	FindUser(ctx context.Context, id int64) (*sqlc.User, error)
	// ListUserManagers returns the (id, manager_id) owner pairs of the
	// requested users in one query (batch scope checks).
	ListUserManagers(ctx context.Context, userIDs []int64) ([]sqlc.ListUsersByIDsRow, error)
	FindUserByUsername(ctx context.Context, username string) (*sqlc.User, error)
	UsernameExists(ctx context.Context, username string) (bool, error)
	UpdateUser(ctx context.Context, user sqlc.User) (*sqlc.User, error)
	UpdatePassword(ctx context.Context, userID int64, userHash string) error
	DeleteUser(ctx context.Context, id int64) error
	// UserReferences returns the counts of records that reference the user and
	// block deletion (see the repository implementation).
	UserReferences(ctx context.Context, id int64) (sqlc.ListUserReferencesRow, error)
	ListUsers(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		presetFilter string,
		managerID int64,
		search string,
		limit, offset int,
	) ([]sqlc.User, error)
	CountUsers(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		presetFilter string,
		managerID int64,
		search string,
	) (int64, error)
	ListAllUsers(ctx context.Context) ([]sqlc.User, error)

	ListStates(ctx context.Context, userID int64, start, end date.Date) ([]sqlc.ListStatesByUserRangeRow, error)
	// ListStatesByUsers is the batch variant of ListStates: the states of a set
	// of workers over one date range, in a single query.
	ListStatesByUsers(
		ctx context.Context,
		userIDs []int64,
		start, end date.Date,
	) ([]sqlc.ListStatesByUsersRangeRow, error)
	SetStateRange(ctx context.Context, userID, stateID int64, start, end date.Date) error
	DeleteStateRange(ctx context.Context, userID int64, start, end date.Date, stateID *int64) error
}
