package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type TaskHandler struct {
	logger  *slog.Logger
	service TaskService
	mw      *rbac.Middleware
}

// NewTaskHandler builds the TaskHandler handler.
func NewTaskHandler(logger *slog.Logger, svc *service.TaskService, mw *rbac.Middleware) *TaskHandler {
	return &TaskHandler{
		logger:  logger.With("component", "task_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListTasks handles the request to list all tasks.
//
//	@Tags			Tasks
//	@Summary		List all tasks
//	@Description	Get a list of all tasks
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit		query		int	false	"Page size (default 50, max 500)"
//	@Param			owner_id	query		int	false	"Filter by task owner (admin/dp)"
//	@Param			offset		query		int	false	"Page offset"
//	@Success		200			{object}	response.SuccessResponse{data=response.Page{items=[]dto.TaskResponse},error=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/task [get]
func (h *TaskHandler) ListTasks(c *gin.Context) {
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
	items, total, err := h.service.ListTasks(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceTask),
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

// FindTask handles the request to get a task by ID.
//
//	@Tags			Tasks
//	@Summary		Get a task by ID
//	@Description	Get a task by its ID
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Task ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.TaskResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id} [get]
func (h *TaskHandler) FindTask(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	task, err := h.service.FindTask(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, task)
}

// CreateTask handles the request to create a new task.
//
//	@Tags			Tasks
//	@Summary		Create a new task
//	@Description	Create a new task
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			task	body		dto.CreateTaskRequest	true	"Task"
//	@Success		201		{object}	response.SuccessResponse{data=dto.TaskResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/task [post]
func (h *TaskHandler) CreateTask(c *gin.Context) {
	var task dto.CreateTaskRequest
	if err := c.ShouldBindJSON(&task); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	if task.OwnerID == nil {
		if user, err := userctx.GetUser(c); err == nil &&
			engine.ScopeForUser(user, rbac.ResourceTask, engine.ActionCreate) != engine.ScopeAll {
			task.OwnerID = &user.ID
		}
	}

	created, err := h.service.CreateTask(c.Request.Context(), task)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteTask handles the request to delete a task.
//
//	@Tags			Tasks
//	@Summary		Delete a task
//	@Description	Delete a task by ID
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id	path	int	true	"Task ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id} [delete]
func (h *TaskHandler) DeleteTask(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	if err = h.service.DeleteTask(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// ReorderTasks handles the request to reorder all tasks of one process.
//
//	@Tags			Tasks
//	@Summary		Reorder tasks
//	@Description	Rewrite the order of all active tasks of a process (the request carries the complete ordered id list)
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			order	body	dto.ReorderTaskRequest	true	"New task order"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/order [put]
func (h *TaskHandler) ReorderTasks(c *gin.Context) {
	var order dto.ReorderTaskRequest
	if err := c.ShouldBindJSON(&order); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	if err := h.service.ReorderTasks(c.Request.Context(), order); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// UpdateTask handles the request to update a task.
//
//	@Tags			Tasks
//	@Summary		Update a task
//	@Description	Update a task by ID
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int						true	"Task ID"
//	@Param			task	body		dto.UpdateTaskRequest	true	"Task data"
//	@Success		200		{object}	response.SuccessResponse{data=dto.TaskResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id} [put]
func (h *TaskHandler) UpdateTask(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	var body dto.UpdateTaskRequest
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	updated, err := h.service.UpdateTask(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, updated)
}
