//nolint:testpackage // verifies the production middleware ordering with an isolated HTTP router.
package server

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	tracingmw "github.com/Koshsky/erp-backend/internal/middleware/tracing"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

func TestRequestDiagnosticsNeverPrintPanicOrUntrustedRequestContent(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil)), tracer: tracing.New(nil)}
	router := gin.New()
	router.Use(a.requestID(), tracingmw.HTTPRootSpan(a.tracer), a.requestLog(), a.recovery())
	router.POST("/task/:id", func(_ *gin.Context) { panic("canary-panic /Users/private/profile") })
	request := httptest.NewRequest(
		http.MethodPost,
		"/task/canary-object?token=canary-query",
		strings.NewReader(`{"password":"canary-body"}`),
	)
	request.Header.Set("Authorization", "Bearer canary-auth")
	request.Header.Set("Cookie", "refresh=canary-cookie")
	request.Header.Set("X-Request-ID", "canary-request-id")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || len(response.Header().Get("X-Request-ID")) != 32 {
		t.Fatalf("panic recovery/correlation failed: %d", response.Code)
	}
	if strings.Contains(logs.String(), "canary-") || strings.Contains(logs.String(), "/Users/") {
		t.Fatalf("request/panic content leaked: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "request panic") || !strings.Contains(logs.String(), "/task/:id") {
		t.Fatalf("safe diagnostic context missing: %s", logs.String())
	}
}
