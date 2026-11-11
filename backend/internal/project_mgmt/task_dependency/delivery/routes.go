package delivery

import (
	"github.com/gin-gonic/gin"
)

// RegisterRoutes registers the nested dependency routes within the existing
// /task subgroup (task visibility/update rights are enforced by policies).
func (h *TaskDependencyHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/task")
	{
		r.GET("/:id/dependencies", h.mw.Check("task.dependency.list"), h.ListDependencies)
		r.POST("/:id/dependencies", h.mw.Check("task.dependency.create"), h.CreateDependency)
		r.PUT("/:id/dependencies/:dep_id", h.mw.Check("task.dependency.update"), h.UpdateDependency)
		r.DELETE("/:id/dependencies/:dep_id", h.mw.Check("task.dependency.delete"), h.DeleteDependency)
	}
}
