//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/auth/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/database"
)

// AuthRepository persists refresh sessions (rotation/revocation, AD-06).
type AuthRepository struct {
	db *sqlc.Queries
}

// NewAuthRepository builds the auth repository.
func NewAuthRepository(pool *pgxpool.Pool) *AuthRepository {
	return &AuthRepository{db: sqlc.New(pool)}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *AuthRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *AuthRepository) FindSessionByHash(ctx context.Context, tokenHash string) (sqlc.FindSessionByHashRow, error) {
	return r.q(ctx).FindSessionByHash(ctx, tokenHash)
}

// FindSessionByReplacedBy returns the session that replaced the given one —
// the next link of the rotation chain used for benign-reuse detection.
func (r *AuthRepository) FindSessionByReplacedBy(
	ctx context.Context,
	id int64,
) (sqlc.FindSessionByReplacedByRow, error) {
	return r.q(ctx).FindSessionByReplacedBy(ctx, id)
}

func (r *AuthRepository) CreateSession(
	ctx context.Context,
	userID int64,
	tokenHash string,
	expiresAt time.Time,
	replacedBy pgtype.Int8,
) (sqlc.CreateSessionRow, error) {
	return r.q(ctx).CreateSession(ctx, sqlc.CreateSessionParams{
		UserID:     userID,
		TokenHash:  tokenHash,
		ExpiresAt:  expiresAt,
		ReplacedBy: replacedBy, // nil for fresh logins; the rotated-away session id on rotation
	})
}

func (r *AuthRepository) RevokeSession(ctx context.Context, id int64) error {
	return r.q(ctx).RevokeSession(ctx, id)
}

func (r *AuthRepository) RevokeAllUserSessions(ctx context.Context, userID int64) error {
	return r.q(ctx).RevokeAllUserSessions(ctx, userID)
}

func (r *AuthRepository) DeleteExpiredSessions(ctx context.Context, olderThan time.Time) error {
	return r.q(ctx).DeleteExpiredSessions(ctx, olderThan)
}
