package cors_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/middleware/cors"
)

func newTestHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Status(http.StatusOK)
	}
}

func doRequest(handler gin.HandlerFunc, method, origin string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(handler)
	router.Any("/test", newTestHandler())

	req := httptest.NewRequest(method, "/test", nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestFromConfigAllowsAnyOrigin(t *testing.T) {
	t.Parallel()
	cfg := config.CORSConfig{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           config.Duration(12 * time.Hour),
	}

	rec := doRequest(cors.FromConfig(cfg), http.MethodGet, "http://192.168.3.172:5173")

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://192.168.3.172:5173" {
		t.Errorf("Allow-Origin = %q, want the echoed origin", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Allow-Credentials = %q, want true", got)
	}
	if got := rec.Header().Get("Access-Control-Max-Age"); got != "43200" {
		t.Errorf("Max-Age = %q, want 43200", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Errorf("Vary = %q, want Origin", got)
	}
}

func TestDisallowedOriginGetsNoAllowOrigin(t *testing.T) {
	t.Parallel()
	cfg := config.CORSConfig{
		AllowOrigins:     []string{"http://allowed.example"},
		AllowMethods:     []string{"GET"},
		AllowCredentials: true,
	}

	rec := doRequest(cors.FromConfig(cfg), http.MethodGet, "http://evil.example")

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin = %q, want empty for disallowed origin", got)
	}
}

func TestPreflightReturnsNoContent(t *testing.T) {
	t.Parallel()
	cfg := config.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"POST"},
	}

	rec := doRequest(cors.FromConfig(cfg), http.MethodOptions, "http://localhost:5173")

	if rec.Code != http.StatusNoContent {
		t.Errorf("preflight status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "POST" {
		t.Errorf("Allow-Methods = %q, want POST", got)
	}
}
