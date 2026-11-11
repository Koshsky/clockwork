package service

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/auth/repository/sqlc"
	userDTO "github.com/Koshsky/erp-backend/internal/user/dto"
)

// UserService is the interface auth depends on instead of a direct repository.
type UserService interface {
	FindUserByUsername(ctx context.Context, username string) (*userDTO.UserResponse, error)
	FindUserByID(ctx context.Context, userID int64) (*userDTO.UserResponse, error)
}

// SessionRepository is the minimal refresh-session store the auth service
// depends on; satisfied by *repository.AuthRepository. Kept as an interface so
// the rotation and reuse-detection logic is unit-testable without a database.
type SessionRepository interface {
	FindSessionByHash(ctx context.Context, tokenHash string) (sqlc.FindSessionByHashRow, error)
	FindSessionByReplacedBy(ctx context.Context, id int64) (sqlc.FindSessionByReplacedByRow, error)
	CreateSession(
		ctx context.Context,
		userID int64,
		tokenHash string,
		expiresAt time.Time,
		replacedBy pgtype.Int8,
	) (sqlc.CreateSessionRow, error)
	RevokeSession(ctx context.Context, id int64) error
	RevokeAllUserSessions(ctx context.Context, userID int64) error
	DeleteExpiredSessions(ctx context.Context, olderThan time.Time) error
}
