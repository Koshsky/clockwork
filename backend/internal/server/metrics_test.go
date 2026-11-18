//nolint:testpackage // exercise the production access-summary/recovery composition.
package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/metrics"
)

func TestRequestMetricsAccountForFinalHTTPOutcomeExactlyOnce(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, outcome         string
		status                int
		failure               error
		panicRequest, partial bool
	}{
		{name: "success", outcome: "success", status: 200},
		{name: "validation", outcome: "validation", status: 422},
		{name: "unauthenticated", outcome: "denied", status: 401},
		{name: "RBAC", outcome: "denied", status: 403},
		{name: "conflict", outcome: "conflict", status: 409},
		{name: "rate limit", outcome: "rate_limited", status: 429},
		{name: "infrastructure", outcome: "server_error", status: 503},
		{name: "HTTP timeout", outcome: "timeout", status: 408},
		{name: "deadline", outcome: "timeout", status: 504, failure: context.DeadlineExceeded},
		{name: "cancel", outcome: "canceled", status: 200, failure: context.Canceled},
		{name: "panic", outcome: "panic", status: 500, panicRequest: true},
		{name: "panic after headers", outcome: "panic", status: 200, panicRequest: true, partial: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			m.SetRoutes([]string{"/tasks/:id"})
			a := &App{metrics: m, logger: slog.New(slog.DiscardHandler)}
			router := gin.New()
			router.Use(a.requestLog(), a.recovery())
			router.GET("/tasks/:id", func(c *gin.Context) {
				setRequestFailure(c, tc.failure)
				if tc.partial {
					c.String(200, "partial")
				}
				if tc.panicRequest {
					panic("canary-secret")
				}
				c.Status(tc.status)
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/tasks/canary-id?token=canary-secret", nil))
			if response.Code != tc.status {
				t.Fatalf("business response changed: %d", response.Code)
			}
			text := scrapeRequestMetrics(m)
			expected := fmt.Sprintf(
				`clockwork_http_requests_total{method="GET",outcome="%s",route="/tasks/:id",status="%d"} 1`,
				tc.outcome,
				tc.status,
			)
			if !strings.Contains(text, expected) || !strings.Contains(text, "clockwork_http_requests_in_flight 0") ||
				strings.Contains(text, "canary") {
				t.Fatalf("incorrect HTTP accounting: expected %s", expected)
			}
		})
	}
}

func scrapeRequestMetrics(m *metrics.Metrics) string {
	r := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, r)
	return w.Body.String()
}

func TestUnknownRoutesAndPublicMetricsPathStayUnmatched(t *testing.T) {
	t.Parallel()
	m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{metrics: m, logger: slog.New(slog.DiscardHandler)}
	router := gin.New()
	router.Use(a.requestLog(), a.recovery())
	for _, path := range []string{"/canary-unknown", "/metrics", "/api/v1/metrics"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != 404 {
			t.Fatal("application router exposed a metrics endpoint")
		}
	}
	text := scrapeRequestMetrics(m)
	if !strings.Contains(
		text,
		`clockwork_http_requests_total{method="GET",outcome="not_found",route="unmatched",status="404"} 3`,
	) ||
		strings.Contains(text, "canary") {
		t.Fatal("404 requests created dynamic labels or were lost")
	}
}

func TestBusyMetricsPortDoesNotBlockBusinessRoutes(t *testing.T) {
	t.Parallel()
	a := &App{logger: slog.New(slog.DiscardHandler)}
	router := gin.New()
	router.Use(a.requestLog())
	router.GET("/tasks", func(c *gin.Context) { c.String(http.StatusOK, "business result") })
	business := httptest.NewUnstartedServer(router)
	m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: business.Listener.Addr().String()}, nil)
	if err != nil {
		business.Close()
		t.Fatal(err)
	}
	a.metrics = m
	a.prepareMetrics(router)
	business.Start()
	t.Cleanup(business.Close)
	a.startMetrics()
	response, err := business.Client().Get(business.URL + "/tasks")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "business result" || m.Address() != "" {
		t.Fatal("auxiliary listener stole or blocked the business API port")
	}
}

func setRequestFailure(c *gin.Context, failure error) {
	if failure == nil {
		return
	}
	ctx, cancel := context.WithCancel(c.Request.Context())
	if errors.Is(failure, context.DeadlineExceeded) {
		cancel()
		ctx, cancel = context.WithDeadline(c.Request.Context(), time.Unix(0, 0))
	}
	cancel()
	c.Request = c.Request.WithContext(ctx)
}

func TestMetricsSeeRequestDeadlineBeforeMiddlewareCleanup(t *testing.T) {
	t.Parallel()
	for _, expire := range []bool{false, true} {
		t.Run(strconv.FormatBool(expire), func(t *testing.T) {
			t.Parallel()
			m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			m.SetRoutes([]string{"/tasks"})
			timeout := time.Second
			if expire {
				timeout = time.Millisecond
			}
			a := &App{
				cfg:     &config.Config{HTTPServer: config.HTTPServerConfig{RequestTimeout: config.Duration(timeout)}},
				metrics: m,
				logger:  slog.New(slog.DiscardHandler),
			}
			router := gin.New()
			router.Use(a.requestTimeout(), a.requestLog(), a.recovery())
			router.GET("/tasks", func(c *gin.Context) {
				if expire {
					<-c.Request.Context().Done()
					c.Status(http.StatusGatewayTimeout)
				} else {
					c.Status(http.StatusOK)
				}
			})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/tasks", nil))
			outcome := "success"
			if expire {
				outcome = "timeout"
			}
			if !strings.Contains(scrapeRequestMetrics(m), `outcome="`+outcome+`"`) {
				t.Fatal("middleware cleanup cancellation replaced the actual request outcome")
			}
		})
	}
}
