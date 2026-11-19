package server

import (
	"github.com/gin-gonic/gin"

	release "github.com/Koshsky/erp-backend"
	"github.com/Koshsky/erp-backend/internal/response"
)

// SetVersion binds release metadata before the HTTP server accepts requests.
func (a *App) SetVersion(version string) {
	a.version = version
	a.metrics.SetVersion(release.NewInfo(version).Version)
}

// applicationInfo returns the release notes embedded in this service.
//
//	@Tags		Application
//	@Summary	Get backend version and release notes
//	@Produce	json
//	@Success	200	{object}	response.SuccessResponse{data=release.Info,error=nil}
//	@Router		/about [get]
func (a *App) applicationInfo(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	response.OK(c, release.NewInfo(a.version))
}
