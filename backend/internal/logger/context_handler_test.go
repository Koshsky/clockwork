package logger_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"github.com/Koshsky/erp-backend/internal/logger"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

// TestContextHandlerEnrichesRecord verifies that records logged with a
// context carrying an OpenTelemetry span and a request id get trace_id,
// span_id and request_id attached by the ContextHandler.
func TestContextHandlerEnrichesRecord(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	l := slog.New(logger.NewContextHandler(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))

	ctx := context.Background()
	ctx = tracing.WithRequestID(ctx, "req-42")
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x01},
		SpanID:     trace.SpanID{0x02},
		TraceFlags: trace.FlagsSampled,
	})
	ctx = trace.ContextWithSpanContext(ctx, sc)

	l.InfoContext(ctx, "hello")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("unmarshal record: %v (raw=%q)", err, buf.String())
	}
	if got := rec["trace_id"]; got != sc.TraceID().String() {
		t.Errorf("trace_id = %v, want %s", got, sc.TraceID().String())
	}
	if got := rec["span_id"]; got != sc.SpanID().String() {
		t.Errorf("span_id = %v, want %s", got, sc.SpanID().String())
	}
	if got := rec["request_id"]; got != "req-42" {
		t.Errorf("request_id = %v, want req-42", got)
	}
}

// TestContextHandlerLeavesBareRecordUnchanged verifies that a record logged
// without a tracing/request context passes through without extra attrs.
func TestContextHandlerLeavesBareRecordUnchanged(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	l := slog.New(logger.NewContextHandler(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))

	l.Info("hello")

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("unmarshal record: %v (raw=%q)", err, buf.String())
	}
	if _, ok := rec["trace_id"]; ok {
		t.Error("trace_id unexpectedly present on a bare record")
	}
	if _, ok := rec["span_id"]; ok {
		t.Error("span_id unexpectedly present on a bare record")
	}
	if _, ok := rec["request_id"]; ok {
		t.Error("request_id unexpectedly present on a bare record")
	}
}
