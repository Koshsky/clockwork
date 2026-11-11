package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository/sqlc"
)

type CommentRepository interface {
	CreateComment(
		ctx context.Context,
		taskID, authorID int64,
		parentID *int64,
		content string,
	) (*sqlc.TaskComment, error)
	FindComment(ctx context.Context, id int64) (*sqlc.TaskComment, error)
	DeleteComment(ctx context.Context, id int64) error
	ListComments(ctx context.Context, taskID int64) ([]sqlc.TaskComment, error)
}
