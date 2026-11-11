package server

import "github.com/gin-gonic/gin"

// Module is implemented by every domain module. Each module registers its own
// routes: public ones (no authentication) and protected ones (behind
// RequireAuth). Route registration, prefixes and per-route RBAC checks stay
// inside the module; the app only collects the modules.
type Module interface {
	RegisterPublicRoutes(r *gin.RouterGroup)
	RegisterProtectedRoutes(r *gin.RouterGroup)
}
