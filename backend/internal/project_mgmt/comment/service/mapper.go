package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type CommentMapper struct{}

func NewCommentMapper() *CommentMapper {
	return &CommentMapper{}
}

func (m *CommentMapper) ToDTO(comment *sqlc.TaskComment) *dto.CommentResponse {
	if comment == nil {
		return nil
	}
	return &dto.CommentResponse{
		ID:        comment.ID,
		TaskID:    comment.TaskID,
		AuthorID:  comment.AuthorID,
		ParentID:  nullable.Int64Ptr(comment.ParentID),
		Content:   comment.Content,
		CreatedAt: comment.CreatedAt,
	}
}

func (m *CommentMapper) ToDTOs(comments []sqlc.TaskComment) []dto.CommentResponse {
	if comments == nil {
		return []dto.CommentResponse{}
	}

	responses := make([]dto.CommentResponse, len(comments))
	for i, comment := range comments {
		responses[i] = *m.ToDTO(&comment)
	}
	return responses
}
