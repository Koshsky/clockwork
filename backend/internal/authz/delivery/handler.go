package delivery

import (
	"log/slog"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/dto"
	"github.com/Koshsky/erp-backend/internal/authz/service"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/response"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// RBACHandler is the HTTP layer for policy administration (all routes are admin-only).
type RBACHandler struct {
	logger  *slog.Logger
	service *service.Service
	mw      *rbac.Middleware
}

// NewRBACHandler builds the RBAC administration handler.
func NewRBACHandler(logger *slog.Logger, svc *service.Service, mw *rbac.Middleware) *RBACHandler {
	return &RBACHandler{logger: logger.With("component", "rbacpolicy_handler"), service: svc, mw: mw}
}

// ListPresets handles the preset catalog listing.
//
//	@Tags		RBAC
//	@Summary	List presets
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=[]dto.PresetView,error=nil}
//	@Router		/rbac/presets [get]
func (h *RBACHandler) ListPresets(c *gin.Context) {
	presets, err := h.service.ListPresets(c.Request.Context())
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, presets)
}

// ListRules handles the matrix rows listing.
//
//	@Tags		RBAC
//	@Summary	List matrix rules
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=[]dto.PresetRuleView,error=nil}
//	@Router		/rbac/preset-rules [get]
func (h *RBACHandler) ListRules(c *gin.Context) {
	rules, err := h.service.ListRules(c.Request.Context())
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, rules)
}

// UpsertRule handles writing a matrix row (upsert by preset/resource/action).
//
//	@Tags		RBAC
//	@Summary	Upsert a matrix rule
//	@Security	ApiKeyAuth
//	@Accept		json
//	@Produce	json
//	@Param		rule	body		dto.PresetRuleInput	true	"Matrix rule"
//	@Success	200		{object}	response.SuccessResponse{data=dto.PresetRuleView,error=nil}
//	@Failure	400		{object}	response.ErrorResponse{data=nil}
//	@Router		/rbac/preset-rules [put]
func (h *RBACHandler) UpsertRule(c *gin.Context) {
	var in dto.PresetRuleInput
	if err := c.ShouldBindJSON(&in); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	userID, err := userctx.GetUserID(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}
	if applyErr := h.service.UpsertRule(c.Request.Context(), in, userID); applyErr != nil {
		response.Error(c, h.logger, applyErr)
		return
	}
	response.OK(c, in)
}

// DeleteRule handles removing a matrix row (archived by the DB trigger).
//
//	@Tags		RBAC
//	@Summary	Delete a matrix rule
//	@Security	ApiKeyAuth
//	@Param		id	path	int	true	"Rule ID"
//	@Success	204
//	@Router		/rbac/preset-rules/{id} [delete]
func (h *RBACHandler) DeleteRule(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid rule id")
		return
	}
	if applyErr := h.service.DeleteRule(c.Request.Context(), id); applyErr != nil {
		response.Error(c, h.logger, applyErr)
		return
	}
	response.NoContent(c)
}

// ListRoutePolicies handles route policy definitions listing.
//
//	@Tags		RBAC
//	@Summary	List route policies
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=[]dto.RoutePolicyView,error=nil}
//	@Router		/rbac/policies [get]
func (h *RBACHandler) ListRoutePolicies(c *gin.Context) {
	policies, err := h.service.ListRoutePolicies(c.Request.Context())
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, policies)
}

// UpsertRoutePolicy handles writing a route policy (kind + params).
//
//	@Tags		RBAC
//	@Summary	Upsert a route policy
//	@Security	ApiKeyAuth
//	@Accept		json
//	@Produce	json
//	@Param		policy	body		dto.RoutePolicyInput	true	"Route policy"
//	@Success	200		{object}	response.SuccessResponse{data=dto.RoutePolicyView,error=nil}
//	@Failure	400		{object}	response.ErrorResponse{data=nil}
//	@Router		/rbac/policies [put]
func (h *RBACHandler) UpsertRoutePolicy(c *gin.Context) {
	var in dto.RoutePolicyInput
	if err := c.ShouldBindJSON(&in); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	userID, err := userctx.GetUserID(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}
	if applyErr := h.service.UpsertRoutePolicy(c.Request.Context(), in, userID); applyErr != nil {
		response.Error(c, h.logger, applyErr)
		return
	}
	response.OK(c, in)
}

// DeleteRoutePolicy handles removing a route policy by name (archived).
//
//	@Tags		RBAC
//	@Summary	Delete a route policy
//	@Security	ApiKeyAuth
//	@Param		name	path	string	true	"Policy name"
//	@Success	204
//	@Router		/rbac/policies/{name} [delete]
func (h *RBACHandler) DeleteRoutePolicy(c *gin.Context) {
	if applyErr := h.service.DeleteRoutePolicy(c.Request.Context(), c.Param("name")); applyErr != nil {
		response.Error(c, h.logger, applyErr)
		return
	}
	response.NoContent(c)
}

// Kinds handles the check kinds reference listing.
//
//	@Tags		RBAC
//	@Summary	List check kinds
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=[]engine.KindInfo,error=nil}
//	@Router		/rbac/kinds [get]
func (h *RBACHandler) Kinds(c *gin.Context) {
	response.OK(c, h.service.Kinds())
}

// Matrix handles the effective matrix listing (with the admin bypass).
//
//	@Tags		RBAC
//	@Summary	Effective permission matrix
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=[]dto.MatrixCell,error=nil}
//	@Router		/rbac/matrix [get]
func (h *RBACHandler) Matrix(c *gin.Context) {
	cells, err := h.service.EffectiveMatrix(c.Request.Context())
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, cells)
}

// Reset handles restoring the built-in default rules.
//
//	@Tags		RBAC
//	@Summary	Reset policies to defaults
//	@Security	ApiKeyAuth
//	@Success	204
//	@Router		/rbac/reset [post]
func (h *RBACHandler) Reset(c *gin.Context) {
	userID, err := userctx.GetUserID(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}
	if applyErr := h.service.Reset(c.Request.Context(), userID); applyErr != nil {
		response.Error(c, h.logger, applyErr)
		return
	}
	response.NoContent(c)
}

// Explain handles the "why allow/deny" decision.
//
//	@Tags		RBAC
//	@Summary	Explain a decision
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Param		preset			query		string	true	"Preset"
//	@Param		resource		query		string	true	"Resource"
//	@Param		action			query		string	true	"Action"
//	@Param		user_id			query		int		false	"User ID"
//	@Param		project_owner	query		int		false	"Project owner ID"
//	@Param		process_owner	query		int		false	"Process owner ID"
//	@Param		owner			query		int		false	"Row owner ID"
//	@Success	200				{object}	response.SuccessResponse{data=dto.ExplainResult,error=nil}
//	@Router		/rbac/explain [get]
func (h *RBACHandler) Explain(c *gin.Context) {
	var in dto.ExplainInput
	if err := c.ShouldBindQuery(&in); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	res, err := h.service.Explain(c.Request.Context(), in)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, res)
}

// MyPermissions handles listing the caller's permitted actions (by effective
// rights, not by preset) — used by the frontend to show/hide capabilities.
//
//	@Tags		Permissions
//	@Summary	My RBAC permissions
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=[]dto.Permission,error=nil}
//	@Router		/permissions/me [get]
func (h *RBACHandler) MyPermissions(c *gin.Context) {
	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}
	response.OK(c, h.service.MyPermissions(c.Request.Context(), user))
}

// CreatePreset handles creating (or reviving) a preset.
//
//	@Tags		RBAC
//	@Summary	Create a preset
//	@Security	ApiKeyAuth
//	@Accept		json
//	@Produce	json
//	@Param		preset	body		dto.PresetUpsertInput	true	"Preset"
//	@Success	201		{object}	response.SuccessResponse{data=dto.PresetView,error=nil}
//	@Failure	400		{object}	response.ErrorResponse{data=nil}
//	@Router		/rbac/presets [post]
func (h *RBACHandler) CreatePreset(c *gin.Context) {
	var in dto.PresetUpsertInput
	if err := c.ShouldBindJSON(&in); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	preset, err := h.service.CreatePreset(c.Request.Context(), in)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.Created(c, preset)
}

// UpdatePreset handles updating a preset (display name and description always,
// optional tag rename).
//
//	@Tags		RBAC
//	@Summary	Update a preset
//	@Security	ApiKeyAuth
//	@Accept		json
//	@Produce	json
//	@Param		tag		path		string					true	"Preset tag"
//	@Param		preset	body		dto.PresetUpdateInput	true	"Preset"
//	@Success	200		{object}	response.SuccessResponse{data=dto.PresetView,error=nil}
//	@Failure	400		{object}	response.ErrorResponse{data=nil}
//	@Router		/rbac/presets/{tag} [put]
func (h *RBACHandler) UpdatePreset(c *gin.Context) {
	var in dto.PresetUpdateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	preset, err := h.service.UpdatePreset(c.Request.Context(), c.Param("tag"), in)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, preset)
}

// DeletePreset handles removing a preset (and its rules); assigned users
// keep existing but lose the preset's base rights.
//
//	@Tags		RBAC
//	@Summary	Delete a preset
//	@Security	ApiKeyAuth
//	@Param		tag	path	string	true	"Preset tag"
//	@Success	204
//	@Router		/rbac/presets/{tag} [delete]
func (h *RBACHandler) DeletePreset(c *gin.Context) {
	if err := h.service.DeletePreset(c.Request.Context(), c.Param("tag")); err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.NoContent(c)
}

// ListUserPermissions handles the per-user permissions view of the editor.
//
//	@Tags		RBAC
//	@Summary	User permissions
//	@Security	ApiKeyAuth
//	@Produce	json
//	@Param		id	path		int	true	"User ID"
//	@Success	200	{object}	response.SuccessResponse{data=dto.UserPermissionsView,error=nil}
//	@Failure	400	{object}	response.ErrorResponse{data=nil}
//	@Router		/rbac/users/{id}/permissions [get]
func (h *RBACHandler) ListUserPermissions(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid user id")
		return
	}
	view, err := h.service.ListUserPermissions(c.Request.Context(), id)
	if err != nil {
		response.Error(c, h.logger, err)
		return
	}
	response.OK(c, view)
}

// ReplaceUserPermissions handles the full replacement of a user's overrides.
//
//	@Tags		RBAC
//	@Summary	Replace user permissions
//	@Security	ApiKeyAuth
//	@Accept		json
//	@Produce	json
//	@Param		id		path		int							true	"User ID"
//	@Param		perms	body		dto.UserPermissionsInput	true	"Permissions"
//	@Success	200		{object}	response.SuccessResponse{data=dto.UserPermissionsInput,error=nil}
//	@Failure	400		{object}	response.ErrorResponse{data=nil}
//	@Router		/rbac/users/{id}/permissions [put]
func (h *RBACHandler) ReplaceUserPermissions(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid user id")
		return
	}
	var in dto.UserPermissionsInput
	if err = c.ShouldBindJSON(&in); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, err.Error())
		return
	}
	userID, err := userctx.GetUserID(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		return
	}
	if applyErr := h.service.ReplaceUserPermissions(c.Request.Context(), id, in, userID); applyErr != nil {
		response.Error(c, h.logger, applyErr)
		return
	}
	response.OK(c, in)
}
