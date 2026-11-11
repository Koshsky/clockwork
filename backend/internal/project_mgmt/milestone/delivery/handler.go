package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/dto"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type MilestoneHandler struct {
	logger  *slog.Logger
	service MilestoneService
	mw      *rbac.Middleware
}

// NewMilestoneHandler builds the MilestoneHandler handler.
func NewMilestoneHandler(logger *slog.Logger, svc *service.MilestoneService, mw *rbac.Middleware) *MilestoneHandler {
	return &MilestoneHandler{
		logger:  logger.With("component", "milestone_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListMilestones handles the request to list all milestones.
//
//	@Tags			Milestones
//	@Summary		List milestones
//	@Description	List all milestones
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit		query		int	false	"Page size (default 50, max 500)"
//	@Param			owner_id	query		int	false	"Filter by process/project owner (admin/dp)"
//	@Param			offset		query		int	false	"Page offset"
//	@Success		200			{object}	response.SuccessResponse{data=response.Page{items=[]dto.MilestoneResponse},error=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/milestone [get]
func (h *MilestoneHandler) ListMilestones(c *gin.Context) {
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
	items, total, err := h.service.ListMilestones(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceMilestone),
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

// FindMilestone handles the request to get a milestone by id.
//
//	@Tags			Milestones
//	@Summary		Get milestone
//	@Description	Get milestone by id
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Milestone ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.MilestoneResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/milestone/{id} [get]
func (h *MilestoneHandler) FindMilestone(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid milestone id")
		return
	}

	milestone, err := h.service.FindMilestone(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, milestone)
}

// CreateMilestone handles the request to create a milestone.
//
//	@Tags			Milestones
//	@Summary		Create milestone
//	@Description	Create milestone with the input payload
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			request	body		dto.CreateMilestoneRequest	true	"Milestone data"
//	@Success		201		{object}	response.SuccessResponse{data=dto.MilestoneResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/milestone [post]
func (h *MilestoneHandler) CreateMilestone(c *gin.Context) {
	var milestone dto.CreateMilestoneRequest
	if err := c.ShouldBindJSON(&milestone); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	created, err := h.service.CreateMilestone(c.Request.Context(), milestone)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteMilestone handles the request to delete a milestone.
//
//	@Tags			Milestones
//	@Summary		Delete milestone
//	@Description	Delete milestone by ID
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path	int	true	"Milestone ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/milestone/{id} [delete]
func (h *MilestoneHandler) DeleteMilestone(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid milestone id")
		return
	}

	if err = h.service.DeleteMilestone(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// UpdateMilestone handles the request to update a milestone.
//
//	@Tags			Milestones
//	@Summary		Update milestone
//	@Description	Update milestone by ID
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Security		ApiKeyAuth
//	@Param			id		path		int							true	"Milestone ID"
//	@Param			body	body		dto.UpdateMilestoneRequest	true	"Milestone data"
//	@Success		200		{object}	response.SuccessResponse{data=dto.MilestoneResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/milestone/{id} [put]
func (h *MilestoneHandler) UpdateMilestone(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid milestone id")
		return
	}

	body := dto.UpdateMilestoneRequest{}
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	updated, err := h.service.UpdateMilestone(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, updated)
}
