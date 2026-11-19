//nolint:testpackage // verify the composed pgx query/batch/acquire adapter.
package database

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/metrics"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

func TestPoolObserverPreservesQueryTracingAndClassifiesAcquires(t *testing.T) {
	t.Parallel()
	m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	adapter := newPoolTracer(tracing.New(provider), m)
	if _, ok := adapter.(pgx.BatchTracer); !ok {
		t.Fatal("batch instrumentation lost")
	}
	poolObserver, ok := adapter.(pgxpool.AcquireTracer)
	if !ok {
		t.Fatal("pool acquisition observer missing")
	}
	ctx := poolObserver.TraceAcquireStart(t.Context(), nil, pgxpool.TraceAcquireStartData{})
	if ctx != t.Context() {
		t.Fatal("pool observer replaced the business context")
	}
	for _, failure := range []error{nil, context.DeadlineExceeded, context.Canceled, errors.New("canary-db-password")} {
		poolObserver.TraceAcquireEnd(ctx, nil, pgxpool.TraceAcquireEndData{Err: failure})
	}
	queryCtx := adapter.TraceQueryStart(t.Context(), nil, pgx.TraceQueryStartData{SQL: "SELECT 'canary-secret'"})
	adapter.TraceQueryEnd(queryCtx, nil, pgx.TraceQueryEndData{})
	if spans := recorder.Ended(); len(spans) != 1 || spans[0].Name() != "DB SELECT" {
		t.Fatal("pool instrumentation changed SQL tracing")
	}
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	response := httptest.NewRecorder()
	m.Handler().ServeHTTP(response, request)
	text := response.Body.String()
	for _, outcome := range []string{"success", "timeout", "canceled", "error"} {
		if !strings.Contains(text, `clockwork_db_pool_acquisitions_total{outcome="`+outcome+`"} 1`) {
			t.Fatalf("missing acquire outcome %s", outcome)
		}
	}
	if strings.Contains(text, "canary") {
		t.Fatal("database error or SQL leaked into metrics")
	}
}

func TestDisabledPoolMetricsPreservesOriginalTracerInterfaces(t *testing.T) {
	t.Parallel()
	if newPoolTracer(nil, nil) != nil {
		t.Fatal("disabled diagnostics created an adapter")
	}
	adapter := newPoolTracer(tracing.New(nil), nil)
	if _, ok := adapter.(pgx.BatchTracer); !ok {
		t.Fatal("disabled metrics removed batch tracing")
	}
	if _, ok := adapter.(pgxpool.AcquireTracer); ok {
		t.Fatal("disabled metrics added acquisition work")
	}
}
