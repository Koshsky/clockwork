//nolint:testpackage // exercises the same writer-backed constructor as production without replacing stdout.
package logger

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/response"
	apierrors "github.com/Koshsky/erp-backend/pkg/errors"
)

func TestTechnicalLogsRejectUnreviewedContent(t *testing.T) {
	t.Parallel()
	for _, format := range []string{FormatJSON, FormatText} {
		t.Run(format, func(t *testing.T) {
			t.Parallel()
			var output bytes.Buffer
			log, err := newLogger(slog.LevelDebug, format, &output)
			if err != nil {
				t.Fatal(err)
			}
			log = log.With("component", "task", "authorization", "canary-auth", "msg", "canary-bound-message")
			log.Error("request failed", "error", errors.New("canary-db"),
				"msg", "canary-message", "time", "canary-time", "level", "canary-level",
				"body", map[string]any{"password": "canary-body"}, "path", "/canary-path",
				"route", "/task/:id", "status", 500, "detail", "canary-detail",
				"request_id", "request-42", "user_id", 17777,
				slog.Group("nested", slog.String("component", "canary-nested")))
			log.WithGroup("credentials").With("version", "canary-group").Info("grouped event")
			text := output.String()
			if strings.Contains(text, "canary-") || strings.Contains(text, "17777") {
				t.Fatalf("unreviewed content escaped the log boundary: %s", text)
			}
			for _, want := range []string{"INTERNAL_ERROR", "request-42", "/task/:id", "task", "500"} {
				if !strings.Contains(text, want) {
					t.Errorf("diagnostic field %q lost: %s", want, text)
				}
			}
		})
	}
}

func TestHTTPErrorDiagnosticsPreserveCodesWithoutDetails(t *testing.T) {
	t.Parallel()
	for _, status := range []int{400, 403, 409, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			t.Parallel()
			var logs bytes.Buffer
			log, err := newLogger(slog.LevelInfo, FormatJSON, &logs)
			if err != nil {
				t.Fatal(err)
			}
			router := gin.New()
			router.GET("/error", func(c *gin.Context) {
				if status == 500 {
					response.InternalError(c, log, "canary-message", errors.New("canary-error"))
					return
				}
				response.Error(c, log, &apierrors.DomainError{
					Status:  status,
					Code:    apierrors.CodeFor(status),
					Message: "request rejected",
					Details: "canary-details",
				})
			})
			result := httptest.NewRecorder()
			router.ServeHTTP(result, httptest.NewRequest(http.MethodGet, "/error", nil))
			if result.Code != status || strings.Contains(result.Body.String()+logs.String(), "canary-") {
				t.Fatalf("unsafe error outcome: %d %s %s", result.Code, result.Body.String(), logs.String())
			}
			if !strings.Contains(logs.String(), apierrors.CodeFor(status).String()) {
				t.Fatalf("error code missing: %s", logs.String())
			}
		})
	}
}
