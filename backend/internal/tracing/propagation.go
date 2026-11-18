package tracing

import (
	"context"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// RequestContext accepts only a bounded W3C traceparent. Public callers are
// untrusted: correlate using a link, never inherit their trace ID or sampling
// decision. Tracestate and baggage cannot cross this boundary. A trusted parent
// already attached by an in-process adapter is preserved.
func RequestContext(ctx context.Context, parents []string) (context.Context, []trace.Link) {
	ctx = baggage.ContextWithoutBaggage(ctx)
	const maxTraceparentLength = 512
	if trace.SpanContextFromContext(ctx).IsValid() || len(parents) != 1 || len(parents[0]) > maxTraceparentLength {
		return ctx, nil
	}
	remote := propagation.TraceContext{}.Extract(
		context.Background(),
		propagation.MapCarrier{"traceparent": parents[0]},
	)
	parent := trace.SpanContextFromContext(remote)
	if !parent.IsValid() {
		return ctx, nil
	}
	parent = parent.WithTraceFlags(0).WithTraceState(trace.TraceState{})
	return ctx, []trace.Link{{SpanContext: parent}}
}
