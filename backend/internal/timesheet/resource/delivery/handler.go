package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/service"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/dto"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type ResourceHandler struct {
	logger  *slog.Logger
	service ResourceService
	mw      *rbac.Middleware
}

// NewResourceHandler builds the ResourceHandler handler.
func NewResourceHandler(logger *slog.Logger, svc *service.ResourceService, mw *rbac.Middleware) *ResourceHandler {
	return &ResourceHandler{
		logger:  logger.With("component", "resource_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListResources handles the request to list all resources.
//
//	@Tags			TimesheetResources
//	@Summary		List resources
//	@Description	List all resources
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit		query		int	false	"Page size (default 50, max 500)"
//	@Param			owner_id	query		int	false	"Filter by resource owner (admin)"
//	@Param			offset		query		int	false	"Page offset"
//	@Success		200			{object}	response.SuccessResponse{data=response.Page{items=[]dto.ResourceResponse},error=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/resources [get]
func (h *ResourceHandler) ListResources(c *gin.Context) {
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
	items, total, err := h.service.ListResources(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceResource),
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

// FindResource handles the request to get a resource by id.
//
//	@Tags			TimesheetResources
//	@Summary		Get resource
//	@Description	Get resource by id
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Resource ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.ResourceResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id} [get]
func (h *ResourceHandler) FindResource(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}

	resource, err := h.service.FindResource(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, resource)
}

// CreateResource handles the request to create a resource.
//
//	@Tags			TimesheetResources
//	@Summary		Create resource
//	@Description	Create resource
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			resource	body		dto.CreateResourceRequest	true	"Resource"
//	@Success		201			{object}	response.SuccessResponse{data=dto.ResourceResponse,error=nil}
//	@Failure		400			{object}	response.ErrorResponse{data=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/resources [post]
func (h *ResourceHandler) CreateResource(c *gin.Context) {
	var resource dto.CreateResourceRequest
	if err := c.ShouldBindJSON(&resource); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	user, err := userctx.GetUser(c)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}

	created, err := h.service.CreateResource(c.Request.Context(), resource, user.ID)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteResource handles the request to delete resource by id.
//
//	@Tags			TimesheetResources
//	@Summary		Delete resource
//	@Description	Delete resource by id
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path	int	true	"Resource ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id} [delete]
func (h *ResourceHandler) DeleteResource(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}

	if err = h.service.DeleteResource(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// UpdateResource handles the request to update resource by id.
//
//	@Tags			TimesheetResources
//	@Summary		Update resource
//	@Description	Update resource by id
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id			path		int							true	"Resource ID"
//	@Param			resource	body		dto.UpdateResourceRequest	true	"Resource"
//	@Success		200			{object}	response.SuccessResponse{data=dto.ResourceResponse,error=nil}
//	@Failure		400			{object}	response.ErrorResponse{data=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id} [put]
func (h *ResourceHandler) UpdateResource(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}

	body := dto.UpdateResourceRequest{}
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	updated, err := h.service.UpdateResource(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, updated)
}

// ListMembers handles the request to list the users of a resource.
//
//	@Tags			TimesheetResources
//	@Summary		List resource members
//	@Description	List the users attached to a resource
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Resource ID"
//	@Success		200	{object}	response.SuccessResponse{data=[]dto.ResourceMemberResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id}/members [get]
func (h *ResourceHandler) ListMembers(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}

	members, err := h.service.ListMembers(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, members)
}

// AddMember handles the request to attach a user to a resource.
//
//	@Tags			TimesheetResources
//	@Summary		Add resource member
//	@Description	Attach a user to a resource (vp — only own subordinates)
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int						true	"Resource ID"
//	@Param			body	body	dto.AddMemberRequest	true	"Member"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		403	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id}/members [post]
func (h *ResourceHandler) AddMember(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}

	var body dto.AddMemberRequest
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	user, err := userctx.GetUser(c)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}

	if err = h.service.AddMember(c.Request.Context(), id, body.UserID, user.ID, user.Admin); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// RemoveMember handles the request to detach a user from a resource.
//
//	@Tags			TimesheetResources
//	@Summary		Remove resource member
//	@Description	Detach a user from a resource
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id		path	int	true	"Resource ID"
//	@Param			userId	path	int	true	"User ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id}/members/{userId} [delete]
func (h *ResourceHandler) RemoveMember(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}
	userID, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid user id")
		return
	}

	if err = h.service.RemoveMember(c.Request.Context(), id, userID); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// ListAbsence handles the request to list the members' absences of a resource.
//
//	@Tags			TimesheetResources
//	@Summary		List resource absences
//	@Description	List absence ranges (is_available=false states) of the resource members
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id			path		int		true	"Resource ID"
//	@Param			start_date	query		string	true	"Start date (YYYY-MM-DD)"
//	@Param			end_date	query		string	true	"End date (YYYY-MM-DD)"
//	@Success		200			{object}	response.SuccessResponse{data=[]dto.ResourceAbsenceResponse,error=nil}
//	@Failure		400			{object}	response.ErrorResponse{data=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/resources/{id}/absence [get]
func (h *ResourceHandler) ListAbsence(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid resource id")
		return
	}

	start, err := date.Parse(c.Query("start_date"))
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid start_date")
		return
	}
	end, err := date.Parse(c.Query("end_date"))
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid end_date")
		return
	}

	absences, err := h.service.ListAbsence(c.Request.Context(), id, start, end)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, absences)
}
