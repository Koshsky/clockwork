package delivery

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	autocreate "github.com/Koshsky/erp-backend/internal/auto_create/service"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type AutoCreateHandler struct {
	logger  *slog.Logger
	service AutoCreateService
	mw      *rbac.Middleware
}

// NewAutoCreateHandler builds the AutoCreateHandler handler.
func NewAutoCreateHandler(
	logger *slog.Logger,
	svc *autocreate.AutoCreateService,
	mw *rbac.Middleware,
) *AutoCreateHandler {
	return &AutoCreateHandler{
		logger:  logger.With("component", "auto_create_handler"),
		service: svc,
		mw:      mw,
	}
}

// GetConfig handles the request to read the auto-create config.
//
//	@Summary		Get auto-create config
//	@Description	Returns the project auto-create configuration (admin)
//	@Tags			AutoCreate
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Success		200	{object}	response.SuccessResponse{data=dto.AutoCreateConfig,error=nil}
//	@Failure		403	{object}	response.ErrorResponse{data=nil}
//	@Failure		500	{object}	response.ErrorResponse{data=nil}
//	@Router			/auto-create/config [get]
func (h *AutoCreateHandler) GetConfig(c *gin.Context) {
	cfg, err := h.service.GetConfig(c.Request.Context())
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, cfg)
}

// SaveConfig handles the request to replace the auto-create config.
//
//	@Summary		Update auto-create config
//	@Description	Replaces the project auto-create configuration (admin)
//	@Tags			AutoCreate
//	@Security		ApiKeyAuth
//	@Accept			json
//	@Produce		json
//	@Param			config	body		dto.AutoCreateConfig	true	"Auto-create config"
//	@Success		200		{object}	response.SuccessResponse{data=dto.AutoCreateConfig,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		403		{object}	response.ErrorResponse{data=nil}
//	@Failure		500		{object}	response.ErrorResponse{data=nil}
//	@Router			/auto-create/config [put]
func (h *AutoCreateHandler) SaveConfig(c *gin.Context) {
	var body dto.AutoCreateConfig
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	if err := h.service.SaveConfig(c.Request.Context(), &body); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, &body)
}
