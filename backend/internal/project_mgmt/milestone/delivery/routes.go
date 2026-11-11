package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *MilestoneHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/milestone")
	{
		r.GET("", h.mw.Check("milestone.list"), h.ListMilestones)
		r.GET("/:id", h.mw.Check("milestone.view"), h.FindMilestone)
		r.POST("", h.mw.Check("milestone.create"), h.CreateMilestone)
		r.PUT("/:id", h.mw.Check("milestone.update"), h.UpdateMilestone)
		r.DELETE("/:id", h.mw.Check("milestone.delete"), h.DeleteMilestone)
	}
}
