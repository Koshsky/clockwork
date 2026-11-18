package tracing_test

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/trace"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/logger"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

func TestRequestBoundaryStripsBaggageAndKeepsTrustedParent(t *testing.T) {
	t.Parallel()
	member, err := baggage.NewMember("user.email", "canary-email")
	if err != nil {
		t.Fatal(err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatal(err)
	}
	parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{1}})
	ctx := baggage.ContextWithBaggage(trace.ContextWithSpanContext(t.Context(), parent), bag)
	clean, links := tracing.RequestContext(ctx, []string{"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"})
	if baggage.FromContext(clean).Len() != 0 || !trace.SpanContextFromContext(clean).Equal(parent) || len(links) != 0 {
		t.Fatal("request metadata crossed the trust boundary or replaced a trusted parent")
	}
}

//nolint:paralleltest // The process-wide SDK error handler is part of the assertion.
func TestExportErrorsNeverLogReceiverDetails(t *testing.T) {
	old := otel.GetErrorHandler()
	t.Cleanup(func() { otel.SetErrorHandler(old) })
	var output bytes.Buffer
	log, err := logger.NewWithWriter("debug", "json", &output)
	if err != nil {
		t.Fatal(err)
	}
	tracer, err := tracing.ProvideTracer(
		config.TracingConfig{Enabled: true, ExporterEndpoint: "localhost:4317"},
		"dev",
		log,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tracer.Shutdown(t.Context()) })
	otel.Handle(errors.New("canary-token postgres://canary-password@host db.canary-table"))
	if strings.Contains(output.String(), "canary") || !strings.Contains(output.String(), "INTERNAL_ERROR") ||
		!strings.Contains(output.String(), `"component":"tracing"`) {
		t.Fatalf("unsafe or missing export error: %s", &output)
	}
}
