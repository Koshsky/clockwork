package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *StateHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/timesheet/states")
	{
		r.GET("", h.mw.Check("state.list"), h.ListStates)
		r.GET("/:id", h.mw.Check("state.view"), h.FindState)
		r.POST("", h.mw.Check("state.create"), h.CreateState)
		r.PUT("/:id", h.mw.Check("state.update"), h.UpdateState)
		r.DELETE("/:id", h.mw.Check("state.delete"), h.DeleteState)
	}
}
