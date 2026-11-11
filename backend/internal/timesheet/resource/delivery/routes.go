package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *ResourceHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/resources")
	{
		r.GET("", h.mw.Check("resource.list"), h.ListResources)
		r.GET("/:id", h.mw.Check("resource.view"), h.FindResource)
		r.POST("", h.mw.Check("resource.create"), h.CreateResource)
		r.PUT("/:id", h.mw.Check("resource.update"), h.UpdateResource)
		r.DELETE("/:id", h.mw.Check("resource.delete"), h.DeleteResource)
		r.GET("/:id/members", h.mw.Check("resource.member-list"), h.ListMembers)
		r.POST("/:id/members", h.mw.Check("resource.member-add"), h.AddMember)
		r.DELETE("/:id/members/:userId", h.mw.Check("resource.member-remove"), h.RemoveMember)
		r.GET("/:id/absence", h.mw.Check("resource.view"), h.ListAbsence)
	}
}
