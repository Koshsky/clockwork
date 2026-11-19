//nolint:testpackage // verify the existing server-owned context boundary.
package server

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
)

func TestRequestContextCarriesLocalOutcomesWithoutMetrics(t *testing.T) {
	t.Parallel()
	counts := diagnostics.NewOutcomes()
	a := &App{outcomes: counts, logger: slog.New(slog.DiscardHandler)}
	router := gin.New()
	router.Use(a.requestID())
	router.GET("/test", func(c *gin.Context) {
		diagnostics.Record(c.Request.Context(), nil, diagnostics.Durable, diagnostics.Accepted, nil)
		c.Status(http.StatusNoContent)
	})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/test", nil))
	if got := counts.Snapshot(); w.Code != 204 || len(got) != 1 || got[0].Total != 1 ||
		w.Header().Get("X-Request-ID") == "" {
		t.Fatal("outcome context required metrics or replaced request correlation")
	}
}
