package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/comment/service"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"
)

type CommentHandler struct {
	logger  *slog.Logger
	service CommentService
	mw      *rbac.Middleware
}

// NewCommentHandler builds the CommentHandler handler.
func NewCommentHandler(logger *slog.Logger, svc *service.CommentService, mw *rbac.Middleware) *CommentHandler {
	return &CommentHandler{
		logger:  logger.With("component", "comment_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListComments handles the request to list comments of a task.
//
//	@Tags			Tasks
//	@Summary		List task comments
//	@Description	Get all comments of a task (flat list, ordered by creation time; the client builds the thread tree by parent_id)
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Task ID"
//	@Success		200	{object}	response.SuccessResponse{data=[]dto.CommentResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/comments [get]
func (h *CommentHandler) ListComments(c *gin.Context) {
	taskID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	items, err := h.service.ListComments(c.Request.Context(), taskID)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, items)
}

// CreateComment handles the request to create a comment on a task.
//
//	@Tags			Tasks
//	@Summary		Create task comment
//	@Description	Create a comment on a task (reply to another comment via parent_id). The author is taken from the authenticated user
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int							true	"Task ID"
//	@Param			comment	body		dto.CreateCommentRequest	true	"Comment data"
//	@Success		201		{object}	response.SuccessResponse{data=dto.CommentResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/comments [post]
func (h *CommentHandler) CreateComment(c *gin.Context) {
	taskID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	var body dto.CreateCommentRequest
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}

	created, err := h.service.CreateComment(c.Request.Context(), taskID, body, user.ID)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteComment handles the request to delete a task comment.
//
//	@Tags			Tasks
//	@Summary		Delete task comment
//	@Description	Soft-delete a comment (replies stay; the thread keeps consistency in the UI)
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id			path	int	true	"Task ID"
//	@Param			comment_id	path	int	true	"Comment ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/comments/{comment_id} [delete]
func (h *CommentHandler) DeleteComment(c *gin.Context) {
	commentID, err := strconv.ParseInt(c.Param("comment_id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid comment id")
		return
	}

	if err = h.service.DeleteComment(c.Request.Context(), commentID); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}
