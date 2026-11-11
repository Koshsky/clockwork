package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/user/dto"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type UserService interface {
	// NormalizeSearch prepares a free-text search pattern for the user list
	// (lowercased and LIKE-escaped); validates its length too.
	NormalizeSearch(search string) (string, error)
	ListAllUsers(ctx context.Context) ([]dto.UserResponse, error)
	ListUsers(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		presetFilter string,
		managerID int64,
		search string,
		limit, offset int,
	) ([]dto.UserResponse, int64, error)
	FindUser(ctx context.Context, id int64) (*dto.UserResponse, error)
	CreateUserWithCreds(
		ctx context.Context,
		req dto.CreateUserRequest,
		caller userctx.UserContext,
	) (*dto.CreateUserResult, error)
	ResetPassword(ctx context.Context, id int64, caller userctx.UserContext) (string, error)
	DeleteUser(ctx context.Context, id int64) error
	ChangePassword(ctx context.Context, userID int64, oldPassword, newPassword string) error
	UpdateUser(
		ctx context.Context,
		id int64,
		user dto.UpdateUserRequest,
		caller userctx.UserContext,
		callerID int64,
	) (*dto.UserResponse, error)
	UpdateManager(
		ctx context.Context,
		id int64,
		managerID *int64,
	) (*dto.UserResponse, error)

	ListStates(ctx context.Context, userID int64, start, end date.Date) ([]dto.UserStateResponse, error)
	// ListStatesBatch returns the calendar states of several workers over one
	// date range in a single request (replaces one ListStates call per employee);
	// each requested id is authorized like the single worker.view endpoint.
	ListStatesBatch(
		ctx context.Context,
		caller userctx.UserContext,
		userIDs []int64,
		start, end date.Date,
	) ([]dto.UserStatesResponse, error)
	SetDays(ctx context.Context, userID int64, req dto.SetDaysRequest) error
	DeleteDays(ctx context.Context, userID int64, start, end date.Date, stateID *int64) error
}
