package delivery

import "github.com/gin-gonic/gin"

// RegisterRoutes registers the admin /audit routes behind the audit.view
// check (the audit virtual resource — admin only by default).
func (h *AuditHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/audit")
	{
		r.GET("/events", h.mw.Check("audit.view"), h.ListEvents)
	}
}
