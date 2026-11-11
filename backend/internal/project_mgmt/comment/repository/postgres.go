//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type CommentRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewCommentRepository builds the CommentRepository repository.
func NewCommentRepository(logger *slog.Logger, pool *pgxpool.Pool) *CommentRepository {
	return &CommentRepository{
		logger: logger.With("component", "comment_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *CommentRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *CommentRepository) CreateComment(
	ctx context.Context,
	taskID, authorID int64,
	parentID *int64,
	content string,
) (*sqlc.TaskComment, error) {
	row, err := r.q(ctx).CreateComment(ctx, sqlc.CreateCommentParams{
		TaskID:   taskID,
		AuthorID: authorID,
		ParentID: nullable.ToInt8(parentID),
		Content:  content,
	})
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *CommentRepository) FindComment(ctx context.Context, id int64) (*sqlc.TaskComment, error) {
	row, err := r.q(ctx).FindComment(ctx, id)
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *CommentRepository) DeleteComment(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteComment(ctx, id)
}

func (r *CommentRepository) ListComments(ctx context.Context, taskID int64) ([]sqlc.TaskComment, error) {
	return r.q(ctx).ListComments(ctx, taskID)
}

// OwnerChain returns the owner chain of a comment (task owners + the author).
func (r *CommentRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	row, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{
		ProjectOwner: row.ProjectOwner,
		ProcessOwner: row.ProcessOwner,
		Owner:        row.Author,
	}, nil
}
