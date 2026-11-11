//nolint:testpackage // constructs App directly to exercise the unexported middlewares
package server

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

// newTestApp builds an App with the given HTTP server settings and a discard
// logger (the middlewares under test only read cfg and logger).
func newTestApp(cfg config.HTTPServerConfig) *App {
	return &App{
		cfg:    &config.Config{HTTPServer: cfg},
		logger: slog.New(slog.DiscardHandler),
	}
}

// runMiddleware executes the given middleware against a synthetic gin engine
// and returns the recorded status code and response body.
func runMiddleware(mw gin.HandlerFunc, req *http.Request, handler gin.HandlerFunc) (int, string) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(mw)
	r.Any("/probe", handler)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

// TestBodyLimitRejectsOversizedBody checks that a body larger than the limit
// surfaces the MaxBytesReader error through the binding path (a 400-class
// client error) rather than being buffered or hanging.
func TestBodyLimitRejectsOversizedBody(t *testing.T) {
	t.Parallel()
	cfg := config.HTTPServerConfig{MaxBodyBytes: 16}
	mw := newTestApp(cfg).bodyLimit()

	body := bytes.NewReader(bytes.Repeat([]byte("x"), 1024))
	req := httptest.NewRequest(http.MethodPost, "/probe", body)
	req.Header.Set("Content-Type", "application/json")

	status, _ := runMiddleware(mw, req, func(c *gin.Context) {
		_, err := io.ReadAll(c.Request.Body)
		if err != nil && strings.Contains(err.Error(), "request body too large") {
			c.Status(http.StatusBadRequest)
			return
		}
		c.Status(http.StatusOK)
	})
	if status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (oversized body must be rejected)", status)
	}
}

// TestBodyLimitAllowsWithinLimit checks that bodies within the limit pass
// through unchanged.
func TestBodyLimitAllowsWithinLimit(t *testing.T) {
	t.Parallel()
	cfg := config.HTTPServerConfig{MaxBodyBytes: 1024}
	mw := newTestApp(cfg).bodyLimit()

	req := httptest.NewRequest(http.MethodPost, "/probe", strings.NewReader("small"))
	status, _ := runMiddleware(mw, req, func(c *gin.Context) {
		got, err := io.ReadAll(c.Request.Body)
		if err != nil || string(got) != "small" {
			t.Errorf("body = %q, err = %v, want %q", got, err, "small")
		}
		c.Status(http.StatusNoContent)
	})
	if status != http.StatusNoContent {
		t.Errorf("status = %d, want 204", status)
	}
}

// TestBodyLimitDisabledIsNoop checks that a non-positive limit leaves the
// request untouched.
func TestBodyLimitDisabledIsNoop(t *testing.T) {
	t.Parallel()
	mw := newTestApp(config.HTTPServerConfig{MaxBodyBytes: 0}).bodyLimit()

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	status, _ := runMiddleware(mw, req, func(c *gin.Context) { c.Status(http.StatusOK) })
	if status != http.StatusOK {
		t.Errorf("status = %d, want 200", status)
	}
}

// TestRequestTimeoutCancelsSlowHandler checks that a handler waiting on the
// request context completes promptly once the timeout fires (no hanging
// goroutine) and the ctx is canceled.
func TestRequestTimeoutCancelsSlowHandler(t *testing.T) {
	t.Parallel()
	cfg := config.HTTPServerConfig{RequestTimeout: config.Duration(20 * time.Millisecond)}
	mw := newTestApp(cfg).requestTimeout()

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)

	start := time.Now()
	status, body := runMiddleware(mw, req, func(c *gin.Context) {
		select {
		case <-c.Request.Context().Done():
			c.String(http.StatusGatewayTimeout, "timed out")
		case <-time.After(5 * time.Second):
			c.String(http.StatusOK, "finished")
		}
	})
	elapsed := time.Since(start)

	if status != http.StatusGatewayTimeout || body != "timed out" {
		t.Errorf("status/body = %d/%q, want 504/\"timed out\"", status, body)
	}
	if elapsed > time.Second {
		t.Errorf("handler took %v, want cancellation shortly after the 20ms timeout", elapsed)
	}
}

// TestRequestTimeoutDisabledIsNoop checks that a non-positive timeout does not
// cancel the request context.
func TestRequestTimeoutDisabledIsNoop(t *testing.T) {
	t.Parallel()
	mw := newTestApp(config.HTTPServerConfig{RequestTimeout: 0}).requestTimeout()

	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	status, _ := runMiddleware(mw, req, func(c *gin.Context) {
		if err := c.Request.Context().Err(); err != nil {
			t.Errorf("ctx.Err() = %v, want nil", err)
		}
		c.Status(http.StatusOK)
	})
	if status != http.StatusOK {
		t.Errorf("status = %d, want 200", status)
	}
}

// TestRequestLogLogsPathNotQuery checks that the request log emits the path
// without the query string (L4: no PII leak via RequestURI).
func TestRequestLogLogsPathNotQuery(t *testing.T) {
	t.Parallel()
	var logBuf bytes.Buffer
	a := &App{logger: slog.New(slog.NewTextHandler(&logBuf, nil))}

	req := httptest.NewRequest(http.MethodGet, "/probe?secret=abc&q=1", nil)
	status, _ := runMiddleware(a.requestLog(), req, func(c *gin.Context) { c.Status(http.StatusOK) })

	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "path=/probe") {
		t.Errorf("log = %q, want path=/probe", logged)
	}
	if strings.Contains(logged, "secret=abc") {
		t.Errorf("log = %q, query string must not be logged", logged)
	}
}

// runRequestID executes a request through the requestID middleware and
// returns the response and the id the middleware stored on the gin context.
func runRequestID(req *http.Request) (*httptest.ResponseRecorder, string) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	a := newTestApp(config.HTTPServerConfig{})
	r.Use(a.requestID())
	r.Use(func(c *gin.Context) {
		c.String(http.StatusOK, c.GetString(tracingpkg.RequestIDKey))
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w, w.Body.String()
}

// TestRequestIDGeneratesMissing checks that a request without the header gets
// a generated id echoed in the response.
func TestRequestIDGeneratesMissing(t *testing.T) {
	t.Parallel()
	w, id := runRequestID(httptest.NewRequest(http.MethodGet, "/probe", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if len(id) != 32 {
		t.Errorf("generated request id = %q, want 32 hex chars", id)
	}
	if got := w.Header().Get("X-Request-ID"); got != id {
		t.Errorf("X-Request-ID header = %q, want %q", got, id)
	}
}

// TestRequestIDCarriesInbound checks that a client-supplied id is preserved.
func TestRequestIDCarriesInbound(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("X-Request-ID", "client-trace-123")
	_, id := runRequestID(req)
	if id != "client-trace-123" {
		t.Errorf("request id = %q, want the inbound header value", id)
	}
}

// TestRequestLogIncludesRequestID checks the request log carries the id (L6).
func TestRequestLogIncludesRequestID(t *testing.T) {
	t.Parallel()
	var logBuf bytes.Buffer
	a := &App{logger: slog.New(slog.NewTextHandler(&logBuf, nil))}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(a.requestID())
	r.Use(a.requestLog())
	r.GET("/probe", func(c *gin.Context) { c.Status(http.StatusOK) })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/probe", nil))

	logged := logBuf.String()
	if !strings.Contains(logged, "request_id=") {
		t.Errorf("log = %q, want a request_id field", logged)
	}
}
