//nolint:testpackage // verify the actual pgx acquire hook and read-only pool statistics.
package database

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/metrics"
)

func TestPoolMetricsObserveRealUsageWaitingTimeoutAndCancellation(t *testing.T) {
	t.Parallel()
	cfg := localMetricsPoolConfig(t)
	cfg.MaxConns = 1
	cfg.MinConns = 0
	m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Tracer = newPoolTracer(nil, m)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("create disposable metrics pool")
	}
	defer pool.Close()
	m.AttachPool(pool)
	if err = pool.Ping(ctx); err != nil {
		t.Fatal("ping disposable metrics pool")
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	text := poolMetricText(m)
	for _, line := range []string{"clockwork_db_pool_available 1", "clockwork_db_pool_acquired_connections 1", "clockwork_db_pool_idle_connections 0", "clockwork_db_pool_max_connections 1"} {
		if !strings.Contains(text, line) {
			t.Fatalf("missing pool usage: %s", line)
		}
	}
	timeoutCtx, stop := context.WithTimeout(ctx, 30*time.Millisecond)
	defer stop()
	if _, err = pool.Acquire(timeoutCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("saturated pool did not time out")
	}
	canceledCtx, stopCanceled := context.WithCancel(ctx)
	stopCanceled()
	if _, err = pool.Acquire(canceledCtx); !errors.Is(err, context.Canceled) {
		t.Fatal("saturated pool did not cancel")
	}
	text = poolMetricText(m)
	for _, line := range []string{`clockwork_db_pool_acquisitions_total{outcome="timeout"} 1`, `clockwork_db_pool_acquisitions_total{outcome="canceled"} 1`, "clockwork_db_pool_canceled_acquires_total 2"} {
		if !strings.Contains(text, line) {
			t.Fatalf("missing real acquisition outcome: %s", line)
		}
	}
	if stat := pool.Stat(); stat.EmptyAcquireCount() < 1 || stat.EmptyAcquireWaitTime() <= 0 {
		t.Fatal("cold pool successful acquire did not expose waiting statistics")
	}
	conn.Release()
	if !strings.Contains(poolMetricText(m), "clockwork_db_pool_acquired_connections 0") {
		t.Fatal("released resource remained acquired")
	}
}

func poolMetricText(m *metrics.Metrics) string {
	r := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, r)
	return w.Body.String()
}

func localMetricsPoolConfig(t *testing.T) *pgxpool.Config {
	t.Helper()
	dsn := os.Getenv("METRICS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("METRICS_TEST_DATABASE_URL is required for a disposable local database")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid metrics test database configuration")
	}
	ip := net.ParseIP(cfg.ConnConfig.Host)
	if ip == nil || !ip.IsLoopback() || !strings.HasPrefix(cfg.ConnConfig.Database, "clockwork_metrics_") {
		t.Fatal("metrics integration requires a loopback disposable clockwork_metrics_ database")
	}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		fallbackIP := net.ParseIP(fallback.Host)
		if fallbackIP == nil || !fallbackIP.IsLoopback() {
			t.Fatal("metrics integration requires loopback fallback hosts")
		}
	}

	return cfg
}
