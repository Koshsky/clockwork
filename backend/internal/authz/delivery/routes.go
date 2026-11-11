package delivery

import "github.com/gin-gonic/gin"

// RegisterRoutes registers the admin /rbac area (everything sits behind the
// rbac.manage check — the rbac_config virtual resource, admin only).
func (h *RBACHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/rbac")
	r.Use(h.mw.Check("rbac.manage"))
	{
		r.GET("/presets", h.ListPresets)
		r.POST("/presets", h.CreatePreset)
		r.PUT("/presets/:tag", h.UpdatePreset)
		r.DELETE("/presets/:tag", h.DeletePreset)
		r.GET("/preset-rules", h.ListRules)
		r.PUT("/preset-rules", h.UpsertRule)
		r.DELETE("/preset-rules/:id", h.DeleteRule)
		r.GET("/policies", h.ListRoutePolicies)
		r.PUT("/policies", h.UpsertRoutePolicy)
		r.DELETE("/policies/:name", h.DeleteRoutePolicy)
		r.GET("/kinds", h.Kinds)
		r.GET("/matrix", h.Matrix)
		r.POST("/reset", h.Reset)
		r.GET("/explain", h.Explain)
		r.GET("/users/:id/permissions", h.ListUserPermissions)
		r.PUT("/users/:id/permissions", h.ReplaceUserPermissions)
	}
}
