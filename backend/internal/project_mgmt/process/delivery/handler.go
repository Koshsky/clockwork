package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/dto"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type ProcessHandler struct {
	logger  *slog.Logger
	service ProcessService
	mw      *rbac.Middleware
}

// NewProcessHandler builds the ProcessHandler handler.
func NewProcessHandler(logger *slog.Logger, svc *service.ProcessService, mw *rbac.Middleware) *ProcessHandler {
	return &ProcessHandler{
		logger:  logger.With("component", "process_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListProcesses handles the request to list all processes.
//
//	@Tags			Processes
//	@Summary		List processes
//	@Description	Get a list of all processes
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit		query		int	false	"Page size (default 50, max 500)"
//	@Param			owner_id	query		int	false	"Filter by process owner (admin/dp)"
//	@Param			offset		query		int	false	"Page offset"
//	@Success		200			{object}	response.SuccessResponse{data=response.Page{items=[]dto.ProcessResponse},error=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/process [get]
func (h *ProcessHandler) ListProcesses(c *gin.Context) {
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
	items, total, err := h.service.ListProcesses(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceProcess),
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

// FindProcess handles the request to get a process by ID.
//
//	@Tags			Processes
//	@Summary		Get process
//	@Description	Get a process by ID
//	@Security		ApiKeyAuth
//	@Param			id	path		int	true	"Process ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.ProcessResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/process/{id} [get]
func (h *ProcessHandler) FindProcess(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid process id")
		return
	}

	process, err := h.service.FindProcess(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, process)
}

// CreateProcess handles the request to create a new process.
//
//	@Tags			Processes
//	@Summary		Create process
//	@Description	Create a new process
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			process	body		dto.CreateProcessRequest	true	"Process data"
//	@Success		201		{object}	response.SuccessResponse{data=dto.ProcessResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/process [post]
func (h *ProcessHandler) CreateProcess(c *gin.Context) {
	var process dto.CreateProcessRequest
	if err := c.ShouldBindJSON(&process); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	if process.OwnerID == nil {
		if user, err := userctx.GetUser(c); err == nil &&
			engine.ScopeForUser(user, rbac.ResourceProcess, engine.ActionCreate) != engine.ScopeAll {
			process.OwnerID = &user.ID
		}
	}

	created, err := h.service.CreateProcess(c.Request.Context(), process)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteProcess handles the request to delete a process.
//
//	@Tags			Processes
//	@Summary		Delete process
//	@Description	Delete a process by ID
//	@Security		ApiKeyAuth
//	@Param			id	path	int	true	"Process ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/process/{id} [delete]
func (h *ProcessHandler) DeleteProcess(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid process id")
		return
	}

	if err = h.service.DeleteProcess(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// ReorderProcesses handles the request to reorder all processes of one project.
//
//	@Tags			Processes
//	@Summary		Reorder processes
//	@Description	Rewrite the order of all active processes of a project (the request carries the complete ordered id list)
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			order	body	dto.ReorderProcessRequest	true	"New process order"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/process/order [put]
func (h *ProcessHandler) ReorderProcesses(c *gin.Context) {
	var order dto.ReorderProcessRequest
	if err := c.ShouldBindJSON(&order); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	if err := h.service.ReorderProcesses(c.Request.Context(), order); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// UpdateProcess handles the request to update a process.
//
//	@Tags			Processes
//	@Summary		Update process
//	@Description	Update a process by ID
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int							true	"Process ID"
//	@Param			body	body		dto.UpdateProcessRequest	true	"Process data"
//	@Success		200		{object}	response.SuccessResponse{data=dto.ProcessResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/process/{id} [put]
func (h *ProcessHandler) UpdateProcess(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid process id")
		return
	}

	body := dto.UpdateProcessRequest{}
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	process, err := h.service.UpdateProcess(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, process)
}
