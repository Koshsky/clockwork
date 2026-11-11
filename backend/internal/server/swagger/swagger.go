// Package swagger registers the embedded Swagger UI on a gin router group.
package swagger

import (
	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
)

// Register mounts the Swagger UI at the given group under /swagger/*any.
// The group is expected to carry the /swagger prefix (and optionally the
// public rate limiter applied by the caller).
func Register(g *gin.RouterGroup) {
	g.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))
}
