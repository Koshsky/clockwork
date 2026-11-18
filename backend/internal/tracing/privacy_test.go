package tracing_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/Koshsky/erp-backend/internal/tracing"
)

func TestQuerySpansNeverContainStatementsArgumentsOrRowErrors(t *testing.T) {
	t.Parallel()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	query := tracing.NewQueryTracer(tracing.New(provider).Unwrap())
	for _, sql := range []string{"SELECT 'canary-query'", "canary-keyword", "/*canary-comment*/ SELECT 1"} {
		ctx := query.TraceQueryStart(
			t.Context(),
			nil,
			pgx.TraceQueryStartData{SQL: sql, Args: []any{"canary-argument"}},
		)
		query.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: &pgconn.PgError{
			Code: "23505", Message: "canary-message", Detail: "canary-row", Where: "/Users/canary-profile",
		}})
	}
	spans := recorder.Ended()
	if len(spans) != 3 {
		t.Fatalf("query outcomes lost: %d", len(spans))
	}
	for _, span := range spans {
		text := fmt.Sprint(span.Name(), span.Attributes(), span.Status(), span.Events())
		if strings.Contains(text, "canary-") || !strings.Contains(text, "DATABASE_ERROR") {
			t.Fatalf("unsafe or missing database outcome: %s", text)
		}
	}
}
