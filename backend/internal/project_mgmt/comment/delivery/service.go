package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/dto"
)

type CommentService interface {
	ListComments(ctx context.Context, taskID int64) ([]dto.CommentResponse, error)
	CreateComment(
		ctx context.Context,
		taskID int64,
		req dto.CreateCommentRequest,
		authorID int64,
	) (*dto.CommentResponse, error)
	DeleteComment(ctx context.Context, commentID int64) error
}
