package logger

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/trace"

	"github.com/Koshsky/erp-backend/internal/tracing"
)

// ContextHandler decorates another [slog.Handler] so that records emitted with
// the *Context logging methods are enriched with the trace context
// (trace_id/span_id) and the request id carried by the record's context. This
// is what correlates log lines with OpenTelemetry spans per HTTP request
// without any global state. Records logged without a context pass through
// unchanged.
type ContextHandler struct {
	next slog.Handler
}

// NewContextHandler wraps next with the context-enrichment handler.
func NewContextHandler(next slog.Handler) *ContextHandler {
	return &ContextHandler{next: next}
}

// Enabled delegates to the wrapped handler.
func (h *ContextHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

// Handle enriches the record with trace_id/span_id (from the OpenTelemetry
// span context) and request_id (from the request context) when present, then
// delegates to the wrapped handler.
func (h *ContextHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	if rid := tracing.RequestIDFrom(ctx); rid != "" {
		r.AddAttrs(slog.String("request_id", rid))
	}
	return h.next.Handle(ctx, r)
}

// WithAttrs delegates and keeps the enrichment in front of the new handler.
func (h *ContextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &ContextHandler{next: h.next.WithAttrs(attrs)}
}

// WithGroup delegates and keeps the enrichment in front of the new handler.
func (h *ContextHandler) WithGroup(name string) slog.Handler {
	return &ContextHandler{next: h.next.WithGroup(name)}
}
