package delivery

import "github.com/gin-gonic/gin"

func (h *AutoCreateHandler) RegisterRoutes(router *gin.RouterGroup) {
	r := router.Group("/auto-create")
	{
		r.GET("/config", h.mw.Check("autocreate.list"), h.GetConfig)
		r.PUT("/config", h.mw.Check("autocreate.update"), h.SaveConfig)
	}
}
