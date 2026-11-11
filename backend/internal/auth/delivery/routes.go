package delivery

import "github.com/gin-gonic/gin"

func (h *AuthHandler) RegisterRoutes(router *gin.RouterGroup, loginGuard, refreshGuard gin.HandlerFunc) {
	r := router.Group("/auth")
	{
		r.POST("/login", loginGuard, h.Login)
		r.POST("/refresh", refreshGuard, h.RefreshToken)
		r.POST("/logout", h.Logout)
	}
}
