package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/dto"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type AssignmentHandler struct {
	logger  *slog.Logger
	service AssignmentService
	mw      *rbac.Middleware
}

// NewAssignmentHandler builds the AssignmentHandler handler.
func NewAssignmentHandler(logger *slog.Logger, svc *service.AssignmentService, mw *rbac.Middleware) *AssignmentHandler {
	return &AssignmentHandler{
		logger:  logger.With("component", "assignment_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListAssignments handles the request to list all assignments.
//
//	@Tags			Assignments
//	@Summary		List assignments
//	@Description	Get a list of all assignments
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit		query		int	false	"Page size (default 50, max 500)"
//	@Param			owner_id	query		int	false	"Filter by project/process owner (admin/dp)"
//	@Param			offset		query		int	false	"Page offset"
//	@Success		200			{object}	response.SuccessResponse{data=response.Page{items=[]dto.AssignmentResponse},error=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/assignment [get]
func (h *AssignmentHandler) ListAssignments(c *gin.Context) {
	limit, offset, perr := response.ParsePagination(c)
	if perr != nil {
		response.Error(c, h.logger, perr)
		return
	}
	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}
	items, total, err := h.service.ListAssignments(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceAssignment),
		response.QueryID(c, "owner_id"),
		limit,
		offset,
	)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}
	response.OK(c, response.Page{Items: items, Total: total, Limit: limit, Offset: offset})
}

// FindAssignment handles the request to find an assignment by ID.
//
//	@Tags			Assignments
//	@Summary		Get assignment
//	@Description	Get assignment by id
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Assignment ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.AssignmentResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/assignment/{id} [get]
func (h *AssignmentHandler) FindAssignment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid assignment id")
		return
	}

	assignment, err := h.service.FindAssignment(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, assignment)
}

// CreateAssignment handles the request to create a new assignment.
//
//	@Tags			Assignments
//	@Summary		Create assignment
//	@Description	Create a new assignment
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		dto.CreateAssignmentRequest	true	"Assignment data"
//	@Success		201		{object}	response.SuccessResponse{data=dto.AssignmentResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/assignment [post]
func (h *AssignmentHandler) CreateAssignment(c *gin.Context) {
	var assignment dto.CreateAssignmentRequest
	if err := c.ShouldBindJSON(&assignment); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	created, err := h.service.CreateAssignment(c.Request.Context(), assignment)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteAssignment handles the deletion of an assignment.
//
//	@Tags			Assignments
//	@Summary		Delete an assignment
//	@Description	Delete an assignment by ID
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path	int	true	"Assignment ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/assignment/{id} [delete]
func (h *AssignmentHandler) DeleteAssignment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid assignment id")
		return
	}

	if err = h.service.DeleteAssignment(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// UpdateAssignment handles the request to update an assignment.
//
//	@Tags			Assignments
//	@Summary		Update an assignment
//	@Description	Update an assignment by ID
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int							true	"Assignment ID"
//	@Param			body	body		dto.UpdateAssignmentRequest	true	"Assignment data"
//	@Success		200		{object}	response.SuccessResponse{data=dto.AssignmentResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/assignment/{id} [put]
func (h *AssignmentHandler) UpdateAssignment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid assignment id")
		return
	}

	body := dto.UpdateAssignmentRequest{}
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	assignment, err := h.service.UpdateAssignment(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, assignment)
}
