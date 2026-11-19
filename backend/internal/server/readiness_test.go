//nolint:testpackage // Test the actual probe route and cache boundary without a business application.
package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

type readinessRow func(...any) error

func (r readinessRow) Scan(values ...any) error { return r(values...) }

type readinessFake struct {
	calls atomic.Int32
	row   func(context.Context) pgx.Row
}

func (f *readinessFake) QueryRow(ctx context.Context, _ string, _ ...any) pgx.Row {
	f.calls.Add(1)
	return f.row(ctx)
}

func TestReadinessLivenessAndPrivacy(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		ready bool
		err   error
		want  int
	}{
		{name: "ready", ready: true, want: http.StatusOK},
		{name: "wrong or dirty schema", want: http.StatusServiceUnavailable},
		{name: "database unavailable", err: errors.New("postgres://private:secret@host/database"), want: http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			db := &readinessFake{row: func(context.Context) pgx.Row {
				return readinessRow(func(values ...any) error { *(values[0].(*bool)) = tc.ready; return tc.err })
			}}
			app := &App{readiness: newReadiness(db)}
			router := gin.New()
			app.registerProbes(router)
			// Simulate an exhausted application limiter installed after probe registration.
			router.Use(func(c *gin.Context) { c.AbortWithStatus(http.StatusTooManyRequests) })
			router.GET("/business", func(c *gin.Context) { c.Status(http.StatusOK) })
			for path, want := range map[string]int{
				"/api/v1/ready": tc.want, "/api/v1/health": http.StatusOK, "/business": http.StatusTooManyRequests,
			} {
				assertProbeResponse(t, router, path, want)
			}

			if db.calls.Load() != 1 {
				t.Fatal("liveness performed SQL")
			}
		})
	}
}

func assertProbeResponse(t *testing.T, router *gin.Engine, path string, want int) {
	t.Helper()
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	if response.Code != want || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("unexpected probe response: %d %s", response.Code, response.Body.String())
	}
	if path == "/api/v1/ready" && response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("readiness must not be cached by a proxy")
	}
}

func TestReadinessBoundsAndCache(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	db := &readinessFake{row: func(ctx context.Context) pgx.Row {
		close(started)
		return readinessRow(func(...any) error { <-ctx.Done(); return ctx.Err() })
	}}
	probe := newReadiness(db)
	done := make(chan bool, 1)
	begin := time.Now()
	go func() { done <- probe.check(t.Context()) }()
	<-started
	if probe.check(t.Context()) {
		t.Fatal("busy probe queued or reported readiness")
	}
	if <-done {
		t.Fatal("slow database reported readiness")
	}
	if time.Since(begin) > 2*time.Second {
		t.Fatal("readiness exceeded its bounded deadline")
	}
	if probe.check(t.Context()) || db.calls.Load() != 1 {
		t.Fatal("failed readiness was not cached")
	}
}

func TestReadinessCancellationDoesNotPoisonCache(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	db := &readinessFake{row: func(context.Context) pgx.Row {
		return readinessRow(func(values ...any) error { *(values[0].(*bool)) = true; return nil })
	}}
	probe := newReadiness(db)
	if probe.check(ctx) || db.calls.Load() != 0 {
		t.Fatal("cancelled request queried the database")
	}
	for range 2 {
		if !probe.check(t.Context()) {
			t.Fatal("healthy cache missing")
		}
	}
	if db.calls.Load() != 1 {
		t.Fatal("cache did not bound SQL calls")
	}
	if (*readinessProbe)(nil).check(t.Context()) || newReadiness(nil).check(t.Context()) {
		t.Fatal("missing database ready")
	}
}
