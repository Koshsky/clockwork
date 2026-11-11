package delivery

import (
	"log/slog"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/service"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type TaskDependencyHandler struct {
	logger  *slog.Logger
	service TaskDependencyService
	mw      *rbac.Middleware
}

// NewTaskDependencyHandler builds the TaskDependencyHandler handler.
func NewTaskDependencyHandler(
	logger *slog.Logger,
	svc *service.TaskDependencyService,
	mw *rbac.Middleware,
) *TaskDependencyHandler {
	return &TaskDependencyHandler{
		logger:  logger.With("component", "task_dependency_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListDependencies handles the request to list the predecessor links of a task.
//
//	@Tags			Tasks
//	@Summary		List task dependencies
//	@Description	Get all dependency links of a task (the predecessors it depends on, with the link type)
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Task ID"
//	@Success		200	{object}	response.SuccessResponse{data=[]dto.DependencyResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/dependencies [get]
func (h *TaskDependencyHandler) ListDependencies(c *gin.Context) {
	taskID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	items, err := h.service.ListDependencies(c.Request.Context(), taskID)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, items)
}

// CreateDependency handles the request to create a dependency link on a task.
//
//	@Tags			Tasks
//	@Summary		Create task dependency
//	@Description	Create a scheduling link: the task (task_id) depends on depends_on_task_id with the given type (fs/ss/ff/sf)
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id			path		int							true	"Task ID"
//	@Param			dependency	body		dto.CreateDependencyRequest	true	"Dependency data"
//	@Success		201			{object}	response.SuccessResponse{data=dto.DependencyResponse,error=nil}
//	@Failure		400			{object}	response.ErrorResponse{data=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/dependencies [post]
func (h *TaskDependencyHandler) CreateDependency(c *gin.Context) {
	taskID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}

	var body dto.CreateDependencyRequest
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	created, err := h.service.CreateDependency(c.Request.Context(), taskID, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// UpdateDependency handles the request to change the type of a dependency link.
//
//	@Tags			Tasks
//	@Summary		Update task dependency
//	@Description	Change the type of an existing dependency link (fs/ss/ff/sf)
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id			path		int							true	"Task ID"
//	@Param			dep_id		path		int							true	"Dependency ID"
//	@Param			dependency	body		dto.UpdateDependencyRequest	true	"New dependency type"
//	@Success		200			{object}	response.SuccessResponse{data=dto.DependencyResponse,error=nil}
//	@Failure		400			{object}	response.ErrorResponse{data=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/dependencies/{dep_id} [put]
func (h *TaskDependencyHandler) UpdateDependency(c *gin.Context) {
	taskID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}
	depID, err := strconv.ParseInt(c.Param("dep_id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid dependency id")
		return
	}

	var body dto.UpdateDependencyRequest
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	updated, err := h.service.UpdateDependencyType(c.Request.Context(), taskID, depID, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, updated)
}

// DeleteDependency handles the request to delete a dependency link.
//
//	@Tags			Tasks
//	@Summary		Delete task dependency
//	@Description	Delete a dependency link by ID
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id		path	int	true	"Task ID"
//	@Param			dep_id	path	int	true	"Dependency ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/task/{id}/dependencies/{dep_id} [delete]
func (h *TaskDependencyHandler) DeleteDependency(c *gin.Context) {
	taskID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid task id")
		return
	}
	depID, err := strconv.ParseInt(c.Param("dep_id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid dependency id")
		return
	}

	if err = h.service.DeleteDependency(c.Request.Context(), taskID, depID); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}
