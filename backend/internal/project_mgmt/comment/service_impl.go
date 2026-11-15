package comment

import (
	"context"
	"log/slog"

	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type Service struct {
	logger     *slog.Logger
	tracer     *tracingpkg.Tracer
	repository Repository
	mapper     *Mapper
	validator  *Validator
}

// NewService builds the comment service.
func NewService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r Repository,
) *Service {
	return &Service{
		logger:     logger.With("component", "comment_service"),
		tracer:     tracer,
		repository: r,
		mapper:     NewMapper(),
		validator:  &Validator{},
	}
}

// CreateComment creates a task comment: the author (authorID) comes from the
// authorization context, and parent_id is a reply to a comment of the same task.
func (s *Service) CreateComment(
	ctx context.Context,
	taskID int64,
	req dto.CreateCommentRequest,
	authorID int64,
) (*dto.CommentResponse, error) {
	ctx, end := s.tracer.Start(ctx, "comment.CreateComment")
	defer end(nil)

	if err := s.validator.ValidateComment(taskID, authorID, req.Content); err != nil {
		return nil, err
	}

	if req.ParentID != nil {
		if _, err := s.findValidParent(ctx, taskID, *req.ParentID); err != nil {
			return nil, err
		}
	}

	created, err := s.repository.CreateComment(ctx, taskID, authorID, req.ParentID, req.Content)
	if err != nil {
		return nil, err
	}

	return s.mapper.ToDTO(created), nil
}

// findValidParent checks that the parent comment exists and belongs to the
// same task (replies cannot reference comments of other tasks).
func (s *Service) findValidParent(ctx context.Context, taskID int64, parentID int64) (*sqlc.TaskComment, error) {
	parent, err := s.repository.FindComment(ctx, parentID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil, errors.BadRequest("parent comment not found")
		}
		return nil, err
	}
	if parent == nil {
		return nil, errors.BadRequest("parent comment not found")
	}
	if parent.TaskID != taskID {
		return nil, errors.BadRequest("parent comment belongs to another task")
	}
	return parent, nil
}

func (s *Service) ListComments(ctx context.Context, taskID int64) ([]dto.CommentResponse, error) {
	ctx, end := s.tracer.Start(ctx, "comment.ListComments")
	defer end(nil)

	rows, err := s.repository.ListComments(ctx, taskID)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTOs(rows), nil
}

func (s *Service) DeleteComment(ctx context.Context, commentID int64) error {
	ctx, end := s.tracer.Start(ctx, "comment.DeleteComment")
	defer end(nil)

	comment, err := s.repository.FindComment(ctx, commentID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return nil // idempotent delete: already deleted — not an error
		}
		return err
	}
	if comment == nil {
		return nil // idempotent delete
	}

	return s.repository.DeleteComment(ctx, commentID)
}
