//nolint:testpackage // verifies summaries on the production request middleware.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/logger"
)

func TestRequestSummarySeverityAndCorrelation(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, level, code string
		status            int
		err               error
	}{
		{"success", "INFO", "", 200, nil},
		{"denial", "INFO", "FORBIDDEN", 403, nil},
		{"conflict", "INFO", "CONFLICT", 409, nil},
		{"server error", "ERROR", "INTERNAL_ERROR", 500, nil},
		{"rate limit", "WARN", "TOO_MANY_REQUESTS", 429, nil},
		{"deadline", "ERROR", "TIMEOUT", 504, context.DeadlineExceeded},
		{"expired success", "WARN", "TIMEOUT", 200, context.DeadlineExceeded},
		{"cancelled", "INFO", "CANCELLED", 200, context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			event, response := requestSummary(t, "/task/:id", tc.status, tc.err)
			if event["level"] != tc.level || event["status"] != float64(tc.status) ||
				event["request_id"] != response.Header().Get("X-Request-ID") {
				t.Fatalf("incorrect request summary: %v", event)
			}
			if tc.code != "" && event["error_code"] != tc.code {
				t.Fatalf("incorrect diagnostic code: %v", event)
			}
		})
	}
}

func TestSuccessfulLivenessSummaryUsesDebug(t *testing.T) {
	t.Parallel()
	event, _ := requestSummary(t, "/api/v1/health", 200, nil)
	if event["level"] != "DEBUG" {
		t.Fatalf("periodic probe floods normal logs: %v", event)
	}
}

func requestSummary(
	t *testing.T,
	route string,
	status int,
	failure error,
) (map[string]any, *httptest.ResponseRecorder) {
	t.Helper()
	var output bytes.Buffer
	log, err := logger.NewWithWriter("debug", "json", &output)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{logger: log}
	router := gin.New()
	router.Use(a.requestID(), a.requestLog())
	router.GET(route, func(c *gin.Context) {
		if failure != nil {
			ctx, cancel := context.WithCancel(c.Request.Context())
			if errors.Is(failure, context.DeadlineExceeded) {
				cancel()
				ctx, cancel = context.WithDeadline(c.Request.Context(), time.Unix(0, 0))
			} else {
				cancel()
			}
			defer cancel()
			c.Request = c.Request.WithContext(ctx)
		}
		c.Status(status)
	})
	response := httptest.NewRecorder()
	target := strings.ReplaceAll(route, ":id", "canary-object") + "?token=canary-query"
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
	var event map[string]any
	if err = json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "canary-") || strings.Count(output.String(), "\n") != 1 ||
		event["route"] != route {
		t.Fatal("request content leaked, route lost or access log duplicated")
	}
	return event, response
}

type failedLogWriter struct{}

func (failedLogWriter) Write(_ []byte) (int, error) { return 0, io.ErrClosedPipe }

func TestFailedLogOutputDoesNotChangeTheResponse(t *testing.T) {
	t.Parallel()
	log, err := logger.NewWithWriter("info", "json", failedLogWriter{})
	if err != nil {
		t.Fatal(err)
	}
	a := &App{logger: log}
	router := gin.New()
	router.Use(a.requestID(), a.requestLog())
	router.GET("/probe", func(c *gin.Context) { c.String(http.StatusOK, "business result") })
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/probe", nil))
	if response.Code != http.StatusOK || response.Body.String() != "business result" {
		t.Fatal("failed diagnostic output changed the business response")
	}
}
