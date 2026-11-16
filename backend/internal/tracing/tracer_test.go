//nolint:testpackage // the shutdown callback is injected to verify lifecycle delegation without an exporter.
package tracing

import (
	"context"
	"errors"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestStartPreservesParentAndRequestID(t *testing.T) {
	t.Parallel()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	tracer := New(provider)
	parent, parentEnd := tracer.Start(WithRequestID(t.Context(), "req-42"), "parent")
	child, childEnd := tracer.Start(parent, "service", trace.WithAttributes(attribute.String("component", "task")))
	if RequestIDFrom(child) != "req-42" {
		t.Fatal("request id was lost in child context")
	}
	childEnd(nil)
	parentEnd(nil)
	spans := recorder.Ended()
	if len(spans) != 2 || spans[0].Name() != "service" || spans[1].Name() != "parent" {
		t.Fatalf("unexpected completed spans: %v", spans)
	}
	if !spans[0].Parent().Equal(spans[1].SpanContext()) || spans[0].Status().Code != codes.Unset {
		t.Fatal("child lost parent or successful status changed")
	}
	if len(spans[0].Attributes()) != 1 || spans[0].Attributes()[0] != attribute.String("component", "task") {
		t.Fatalf("start options were lost: %v", spans[0].Attributes())
	}
}

func TestStartRecordsOperationError(t *testing.T) {
	t.Parallel()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	_, end := New(provider).Start(t.Context(), "failed mutation")
	failure := errors.New("write refused")
	end(failure)
	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("completed spans: %d", len(spans))
	}
	span := spans[0]
	if span.Status().Code != codes.Error || span.Status().Description != failure.Error() {
		t.Fatalf("failure status lost: %v", span.Status())
	}
	if len(span.Events()) != 1 || span.Events()[0].Name != "exception" {
		t.Fatalf("exception event lost: %v", span.Events())
	}
	if len(span.Attributes()) != 1 || span.Attributes()[0] != attribute.String(AttrErrorMessage, failure.Error()) {
		t.Fatalf("error attribute lost: %v", span.Attributes())
	}
}

func TestDisabledTracerPreservesContext(t *testing.T) {
	t.Parallel()
	tracer, err := NewTracer(Config{Enabled: false})
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithRequestID(t.Context(), "offline-tracing")
	child, end := tracer.Start(ctx, "disabled")
	if RequestIDFrom(child) != "offline-tracing" || trace.SpanFromContext(child).IsRecording() {
		t.Fatal("disabled tracing changed the request context")
	}
	end(nil)
	if err = tracer.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestShutdownUsesCallerContextAndReturnsFailure(t *testing.T) {
	t.Parallel()
	failure := errors.New("export flush failed")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	called := false
	tracer := New(nil)
	tracer.shutdown = func(got context.Context) error {
		called = true
		if got != ctx || !errors.Is(got.Err(), context.Canceled) {
			t.Fatal("shutdown did not receive its caller's context")
		}
		return failure
	}
	if err := tracer.Shutdown(ctx); !called || !errors.Is(err, failure) {
		t.Fatalf("shutdown callback/failure lost: called=%v, error=%v", called, err)
	}
}

func TestRequestIDContextIsolation(t *testing.T) {
	t.Parallel()
	parent := WithRequestID(t.Context(), "first")
	child := WithRequestID(parent, "second")
	if RequestIDFrom(t.Context()) != "" || RequestIDFrom(parent) != "first" || RequestIDFrom(child) != "second" {
		t.Fatal("request ids leak across context boundaries")
	}
}
