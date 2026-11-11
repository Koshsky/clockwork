package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/dto"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type ProjectHandler struct {
	logger  *slog.Logger
	service ProjectService
	mw      *rbac.Middleware
}

// NewProjectHandler builds the ProjectHandler handler.
func NewProjectHandler(logger *slog.Logger, svc *service.ProjectService, mw *rbac.Middleware) *ProjectHandler {
	return &ProjectHandler{
		logger:  logger.With("component", "project_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListProjects handles the request to list all projects.
//
//	@Tags			Projects
//	@Summary		List all projects
//	@Description	Get a list of all projects
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit		query		int	false	"Page size (default 50, max 500)"
//	@Param			owner_id	query		int	false	"Filter by project owner (admin/dp)"
//	@Param			offset		query		int	false	"Page offset"
//	@Success		200			{object}	response.SuccessResponse{data=response.Page{items=[]dto.ProjectResponse},error=nil}
//	@Failure		500			{object}	response.ErrorResponse{data=nil}
//	@Router			/project [get]
func (h *ProjectHandler) ListProjects(c *gin.Context) {
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
	items, total, err := h.service.ListProjects(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceProject),
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

// FindProject handles the request to get a project by ID.
//
//	@Tags			Projects
//	@Summary		Get a project by ID
//	@Description	Get a project by its ID
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"Project ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.ProjectResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/project/{id} [get]
func (h *ProjectHandler) FindProject(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid project id")
		return
	}

	project, err := h.service.FindProject(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, project)
}

// CreateProject handles the request to create a new project.
//
//	@Tags			Projects
//	@Summary		Create project
//	@Description	Create a new project
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			project	body		dto.CreateProjectRequest	true	"Project data"
//	@Success		201		{object}	response.SuccessResponse{data=dto.CreateProjectResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/project [post]
func (h *ProjectHandler) CreateProject(c *gin.Context) {
	var project dto.CreateProjectRequest
	if err := c.ShouldBindJSON(&project); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	user, err := userctx.GetUser(c)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}

	created, err := h.service.CreateProject(
		c.Request.Context(),
		project,
		user.ID,
		engine.ScopeForUser(user, rbac.ResourceProject, engine.ActionCreate) == engine.ScopeOwn,
	)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// UpdateProject handles the request to update a project.
//
//	@Tags			Projects
//	@Summary		Update project
//	@Description	Update code, dates, priority or owner of a project
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int							true	"Project ID"
//	@Param			body	body		dto.UpdateProjectRequest	true	"Project data"
//	@Success		200		{object}	response.SuccessResponse{data=dto.ProjectResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/project/{id} [put]
func (h *ProjectHandler) UpdateProject(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid project id")
		return
	}

	body := dto.UpdateProjectRequest{}
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	updated, err := h.service.UpdateProject(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, updated)
}

// DeleteProject handles the request to delete a project.
//
//	@Tags			Projects
//	@Summary		Delete a project
//	@Description	Delete a project by ID
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path	int	true	"Project ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/project/{id} [delete]
func (h *ProjectHandler) DeleteProject(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid project id")
		return
	}

	if err = h.service.DeleteProject(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}
