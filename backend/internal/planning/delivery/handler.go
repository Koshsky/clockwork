package delivery

import (
	"log/slog"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	planningservice "github.com/Koshsky/erp-backend/internal/planning/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type PlanningHandler struct {
	logger  *slog.Logger
	service MilestoneService
	mw      *rbac.Middleware
}

// NewPlanningHandler builds the planning handler.
func NewPlanningHandler(
	logger *slog.Logger,
	svc *planningservice.PlanningService,
	mw *rbac.Middleware,
) *PlanningHandler {
	return &PlanningHandler{
		logger:  logger.With("component", "planning_handler"),
		service: svc,
		mw:      mw,
	}
}

// GetProjectPlanning handles the request to get project planning (project portfolio).
//
//	@Tags			Planning
//	@Summary		Get project planning
//	@Description	Get project planning (project portfolio)
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Success		200	{object}	response.SuccessResponse{data=dto.ProjectPlanning,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/planning/projects [get]
func (h *PlanningHandler) GetProjectPlanning(c *gin.Context) {
	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}

	planning, err := h.service.GetProjectPlanning(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceProject),
	)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}
	response.OK(c, planning)
}

// GetProcessPlanning handles the request to get process planning.
//
//	@Tags			Planning
//	@Summary		Get process planning
//	@Description	Get process planning
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Success		200	{object}	response.SuccessResponse{data=dto.ProcessPlanning,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/planning/processes [get]
func (h *PlanningHandler) GetProcessPlanning(c *gin.Context) {
	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}

	planning, err := h.service.GetProcessPlanning(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceProcess),
		engine.CompileViewScopeUser(user, rbac.ResourceProject),
	)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}
	response.OK(c, planning)
}

// GetTaskPlanning handles the request to get task planning.
//
//	@Tags			Planning
//	@Summary		Get task planning
//	@Description	Get task planning
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Success		200	{object}	response.SuccessResponse{data=dto.TaskPlanning,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/planning/tasks [get]
func (h *PlanningHandler) GetTaskPlanning(c *gin.Context) {
	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}

	planning, err := h.service.GetTaskPlanning(
		c.Request.Context(),
		user.ID,
		engine.CompileViewScopeUser(user, rbac.ResourceTask),
		engine.CompileViewScopeUser(user, rbac.ResourceResource),
	)
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}
	response.OK(c, planning)
}
