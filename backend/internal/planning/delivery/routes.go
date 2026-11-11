package delivery

import "github.com/gin-gonic/gin"

func (h *PlanningHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("planning")
	{
		r.GET("/projects", h.mw.Check("planning.projects"), h.GetProjectPlanning)
		r.GET("/processes", h.mw.Check("planning.processes"), h.GetProcessPlanning)
		r.GET("/tasks", h.mw.Check("planning.tasks"), h.GetTaskPlanning)
	}
}
