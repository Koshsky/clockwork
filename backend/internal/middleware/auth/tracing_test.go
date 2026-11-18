package auth_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	authmw "github.com/Koshsky/erp-backend/internal/middleware/auth"
	tracingmw "github.com/Koshsky/erp-backend/internal/middleware/tracing"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

func TestAuthenticatedPrincipalEnrichesHTTPRoot(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, target string
		authorized   bool
		userID       int64
		status       int
	}{
		{name: "actor", authorized: true, userID: 1, status: http.StatusOK},
		{name: "view subject", target: "7", authorized: true, userID: 7, status: http.StatusOK},
		{name: "unauthenticated", status: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			recorder := tracetest.NewSpanRecorder()
			provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
			t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
			tracer := tracingpkg.New(provider)
			jwt := newJWT(testSecret, testIssuer, time.Hour)
			mw := authmw.ProvideAuthMiddleware(slog.New(slog.DiscardHandler), jwt, viewResolver{admin: true})
			router := gin.New()
			router.Use(tracingmw.HTTPRootSpan(tracer), tracingmw.GinSpan(tracer, "middleware.auth"), mw.RequireAuth())
			router.GET("/api/v1/planning/tasks", func(c *gin.Context) {
				principal, err := userctx.GetUser(c)
				if err != nil || principal.ID != tc.userID {
					t.Fatalf("wrong neutral principal: %v, %v", principal, err)
				}
				c.Status(http.StatusOK)
			})
			request := httptest.NewRequest(http.MethodGet, "/api/v1/planning/tasks", nil)
			if tc.authorized {
				request.Header.Set("Authorization", bearerToken(t, jwt, 1, "test@example.com"))
			}
			request.Header.Set("X-View-User-Id", tc.target)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			spans := recorder.Ended()
			if response.Code != tc.status || len(spans) != 2 {
				t.Fatalf("response=%d, completed spans=%d", response.Code, len(spans))
			}
			assertRootPrincipal(t, spans[1], tc.userID)
		})
	}
}

func assertRootPrincipal(t *testing.T, span sdktrace.ReadOnlySpan, wantID int64) {
	t.Helper()

	found := false
	for _, attr := range span.Attributes() {
		if attr.Key == tracingpkg.AttrUserID || attr.Key == tracingpkg.AttrUserRole {
			t.Fatal("principal identity leaked into diagnostics")
		}
		if attr.Key != "user.authenticated" {
			continue
		}
		found = true
		if wantID == 0 || !attr.Value.AsBool() {
			t.Fatalf("wrong root principal attribute: %v", attr)
		}
	}
	if found != (wantID != 0) {
		t.Fatal("HTTP root principal attribute presence differs from authenticated state")
	}
}
