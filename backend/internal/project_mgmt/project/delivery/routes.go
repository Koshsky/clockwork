package delivery

import (
	"github.com/gin-gonic/gin"
)

func (h *ProjectHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/project")
	{
		r.GET("", h.mw.Check("project.list"), h.ListProjects)
		r.GET("/:id", h.mw.Check("project.view"), h.FindProject)
		r.POST("", h.mw.Check("project.create"), h.CreateProject)
		r.PUT("/:id", h.mw.Check("project.update"), h.UpdateProject)
		r.DELETE("/:id", h.mw.Check("project.delete"), h.DeleteProject)
	}
}
