// Package tracing provides OpenTelemetry-based distributed tracing for the
// whole request path: HTTP → middleware → service → SQL. It exposes a small
// [Tracer] facade over a shared *trace.TracerProvider so that every layer can
// start child spans without reaching for global state.
package tracing

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// Span attribute names shared across the request trace.
const (
	AttrHTTPMethod     = "http.method"
	AttrHTTPPath       = "http.target"
	AttrHTTPStatusCode = "http.status_code"
	AttrUserID         = "user.id"
	AttrUserRole       = "user.role"
	AttrErrorMessage   = "error.message"
	AttrRequestID      = "request.id"
)

// RequestIDKey identifies the request id shared by HTTP adapters and logging.
const RequestIDKey = "x-request-id"

// requestIDKey is the context key under which the per-request id is carried
// in the request context (via WithRequestID). A zero-size struct type is used
// instead of a package-level variable so the key is collision-free and
// gochecknoglobals stays satisfied.
type requestIDKey struct{}

// WithRequestID returns a context carrying the per-request id, so that
// context-aware slog logging (logger.ContextHandler) attaches request_id to
// every record emitted during the request.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// RequestIDFrom returns the per-request id stored via WithRequestID, or an
// empty string outside a request.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// Tracer is the app-wide tracer facade. It wraps a *trace.Tracer obtained from
// the shared provider; when tracing is disabled the no-op tracer is used.
type Tracer struct {
	tracer   trace.Tracer
	shutdown func(context.Context) error
}

// New builds a Tracer over the given provider. When tp is nil the no-op tracer
// is used (no spans created, no cost).
func New(tp trace.TracerProvider) *Tracer {
	if tp == nil {
		tp = noop.NewTracerProvider()
	}
	return &Tracer{tracer: tp.Tracer("erp-backend"), shutdown: func(context.Context) error { return nil }}
}

// NewTracer builds and starts the trace SDK from cfg, returning a Tracer ready
// to be injected across layers. When tracing is disabled a no-op tracer is
// returned and Shutdown is a no-op.
func NewTracer(cfg Config) (*Tracer, error) {
	tp, shutdown, err := Setup(cfg)
	if err != nil {
		return nil, err
	}
	if tp == nil {
		return New(nil), nil
	}
	return &Tracer{tracer: tp.Tracer("erp-backend"), shutdown: shutdown}, nil
}

// Unwrap exposes the underlying OpenTelemetry tracer (used to attach the DB
// query tracer to the connection pool).
func (t *Tracer) Unwrap() trace.Tracer {
	return t.tracer
}

// Shutdown flushes and shuts down the trace SDK (no-op when tracing disabled).
func (t *Tracer) Shutdown(ctx context.Context) error {
	return t.shutdown(ctx)
}

// Start creates a child span of the span found in ctx. It returns the child
// context to pass deeper and an end function that records an optional error
// (pass the error the enclosing operation returns, nil otherwise).
//
//nolint:spancheck // span is ended by the returned end func, which every caller defers.
func (t *Tracer) Start(
	ctx context.Context,
	name string,
	opts ...trace.SpanStartOption,
) (context.Context, func(err error)) {
	ctx, span := t.tracer.Start(ctx, name, opts...)
	return ctx, func(err error) {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			span.SetAttributes(attribute.String(AttrErrorMessage, err.Error()))
		}
		span.End()
	}
}
