package delivery

import (
	"log/slog"
	"strconv"

	"github.com/Koshsky/erp-backend/internal/timesheet/state/service"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/dto"
)

type StateHandler struct {
	logger  *slog.Logger
	service StateService
	mw      *rbac.Middleware
}

// NewStateHandler builds the StateHandler handler.
func NewStateHandler(logger *slog.Logger, svc *service.StateService, mw *rbac.Middleware) *StateHandler {
	return &StateHandler{
		logger:  logger.With("component", "state_handler"),
		service: svc,
		mw:      mw,
	}
}

// ListStates handles the request to list all states.
//
//	@Tags			TimesheetStates
//	@Summary		List states
//	@Description	List all resource states (reference dictionary)
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Success		200	{object}	response.SuccessResponse{data=[]dto.StateResponse,error=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/timesheet/states [get]
func (h *StateHandler) ListStates(c *gin.Context) {
	states, err := h.service.ListStates(c.Request.Context())
	if err != nil {
		response.InternalError(c, h.logger, err.Error(), err)
		return
	}
	response.OK(c, states)
}

// FindState handles the request to get a state by id.
//
//	@Tags			TimesheetStates
//	@Summary		Get state
//	@Description	Get a resource state by id
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path		int	true	"State ID"
//	@Success		200	{object}	response.SuccessResponse{data=dto.StateResponse,error=nil}
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/timesheet/states/{id} [get]
func (h *StateHandler) FindState(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid state id")
		return
	}

	state, err := h.service.FindState(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, state)
}

// CreateState handles the request to create a state.
//
//	@Tags			TimesheetStates
//	@Summary		Create state
//	@Description	Create a resource state (reference dictionary)
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			state	body		dto.CreateStateRequest	true	"State"
//	@Success		201		{object}	response.SuccessResponse{data=dto.StateResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/timesheet/states [post]
func (h *StateHandler) CreateState(c *gin.Context) {
	var state dto.CreateStateRequest
	if err := c.ShouldBindJSON(&state); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	created, err := h.service.CreateState(c.Request.Context(), state)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, created)
}

// DeleteState handles the request to delete a state by id.
//
//	@Tags			TimesheetStates
//	@Summary		Delete state
//	@Description	Delete a resource state by id
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			id	path	int	true	"State ID"
//	@Success		204
//	@Failure		400	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/timesheet/states/{id} [delete]
func (h *StateHandler) DeleteState(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid state id")
		return
	}

	if err = h.service.DeleteState(c.Request.Context(), id); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// UpdateState handles the request to update a state by id.
//
//	@Tags			TimesheetStates
//	@Summary		Update state
//	@Description	Update a resource state by id
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			id		path		int						true	"State ID"
//	@Param			state	body		dto.UpdateStateRequest	true	"State"
//	@Success		200		{object}	response.SuccessResponse{data=dto.StateResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/timesheet/states/{id} [put]
func (h *StateHandler) UpdateState(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid state id")
		return
	}

	body := dto.UpdateStateRequest{}
	if err = c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}

	updated, err := h.service.UpdateState(c.Request.Context(), id, body)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, updated)
}
