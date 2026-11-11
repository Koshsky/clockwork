package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *TaskHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/task")
	{
		r.GET("", h.mw.Check("task.list"), h.ListTasks)
		r.GET("/:id", h.mw.Check("task.view"), h.FindTask)
		r.POST("", h.mw.Check("task.create"), h.CreateTask)
		r.PUT("/order", h.mw.Check("task.order"), h.ReorderTasks)
		r.PUT("/:id", h.mw.Check("task.update"), h.UpdateTask)
		r.DELETE("/:id", h.mw.Check("task.delete"), h.DeleteTask)
	}
}
