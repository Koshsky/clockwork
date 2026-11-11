package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *ProcessHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/process")
	{
		r.GET("", h.mw.Check("process.list"), h.ListProcesses)
		r.GET("/:id", h.mw.Check("process.view"), h.FindProcess)
		r.POST("", h.mw.Check("process.create"), h.CreateProcess)
		r.PUT("/order", h.mw.Check("process.order"), h.ReorderProcesses)
		r.PUT("/:id", h.mw.Check("process.update"), h.UpdateProcess)
		r.DELETE("/:id", h.mw.Check("process.delete"), h.DeleteProcess)
	}
}
