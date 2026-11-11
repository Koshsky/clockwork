package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *AssignmentHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/assignment")
	{
		r.GET("", h.mw.Check("assignment.list"), h.ListAssignments)
		r.GET("/:id", h.mw.Check("assignment.view"), h.FindAssignment)
		r.POST("", h.mw.Check("assignment.create"), h.CreateAssignment)
		r.PUT("/:id", h.mw.Check("assignment.update"), h.UpdateAssignment)
		r.DELETE("/:id", h.mw.Check("assignment.delete"), h.DeleteAssignment)
	}
}
