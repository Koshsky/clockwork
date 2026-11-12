package delivery

import (
	"net/url"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

const (
	sessionTransportHeader = "X-Erp-Session"
	sessionTransportCookie = "cookie"
)

// Browser fetch metadata survives same-origin reverse proxies without trusting
// arbitrary forwarded-host headers. Legacy desktop origins use body credentials.
func browserSessionAllowed(c *gin.Context, cookieOnly bool) bool {
	site := c.GetHeader("Sec-Fetch-Site")
	origin := c.GetHeader("Origin")
	if site == "same-origin" || ((site == "" || site == "none") && origin == "") {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" || u.RawQuery != "" ||
		u.Fragment != "" {
		return false
	}
	if site == "" && u.Host == c.Request.Host {
		return true
	}
	if cookieOnly || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") {
		return false
	}
	const firstDesktopPort, lastDesktopPort = 31880, 31899
	port, err := strconv.Atoi(u.Port())
	return err == nil && port >= firstDesktopPort && port <= lastDesktopPort
}

func requireBrowserSession(c *gin.Context, cookieOnly bool) bool {
	c.Header("Cache-Control", "no-store")
	if browserSessionAllowed(c, cookieOnly) {
		return true
	}
	response.Forbidden(c, errors.CodeForbidden, "forbidden")
	return false
}
