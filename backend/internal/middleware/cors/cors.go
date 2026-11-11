package cors

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
)

type Config struct {
	AllowOrigins     []string
	AllowMethods     []string
	AllowHeaders     []string
	ExposeHeaders    []string
	AllowCredentials bool
	MaxAge           time.Duration
}

// FromConfig builds a CORS handler from the application configuration.
func FromConfig(cfg config.CORSConfig) gin.HandlerFunc {
	return New(Config{
		AllowOrigins:     cfg.AllowOrigins,
		AllowMethods:     cfg.AllowMethods,
		AllowHeaders:     cfg.AllowHeaders,
		ExposeHeaders:    cfg.ExposeHeaders,
		AllowCredentials: cfg.AllowCredentials,
		MaxAge:           time.Duration(cfg.MaxAge),
	})
}

func New(config Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Caches must vary on Origin: the Allow-Origin header is echoed per
		// request, so a cached response for one origin must not be served to another.
		c.Header("Vary", "Origin")

		setAllowHeaders(c, config, origin, isOriginAllowed(config.AllowOrigins, origin))

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}

// isOriginAllowed reports whether the request origin is permitted.
func isOriginAllowed(allowOrigins []string, origin string) bool {
	for _, allowedOrigin := range allowOrigins {
		if allowedOrigin == "*" || allowedOrigin == origin {
			return true
		}
	}
	return false
}

// setAllowHeaders writes the CORS response headers for the request.
func setAllowHeaders(c *gin.Context, config Config, origin string, allowed bool) {
	// With credentials, the wildcard "*" cannot be sent literally; the
	// specific origin is echoed instead so browsers accept the request.
	if allowed {
		c.Header("Access-Control-Allow-Origin", origin)
	}

	if len(config.AllowMethods) > 0 {
		c.Header("Access-Control-Allow-Methods", joinStrings(config.AllowMethods))
	}

	// Reflect the set of headers requested by the client in preflight.
	// This is more reliable than a fixed AllowHeaders: the browser does not
	// form arbitrary headers by itself, and the server allows exactly what
	// the client really requested.
	// This approach (echoing Access-Control-Request-Headers) is used by rs/cors and GoCORS.
	if requestedHeaders := c.Request.Header.Get("Access-Control-Request-Headers"); requestedHeaders != "" {
		c.Header("Access-Control-Allow-Headers", requestedHeaders)
	} else if len(config.AllowHeaders) > 0 {
		c.Header("Access-Control-Allow-Headers", joinStrings(config.AllowHeaders))
	}

	if len(config.ExposeHeaders) > 0 {
		c.Header("Access-Control-Expose-Headers", joinStrings(config.ExposeHeaders))
	}

	if config.AllowCredentials {
		c.Header("Access-Control-Allow-Credentials", "true")
	}

	if config.MaxAge > 0 {
		c.Header("Access-Control-Max-Age", strconv.Itoa(int(config.MaxAge.Seconds())))
	}
}

func joinStrings(strs []string) string {
	var result strings.Builder
	for i, s := range strs {
		if i > 0 {
			result.WriteString(", ")
		}
		result.WriteString(s)
	}
	return result.String()
}
