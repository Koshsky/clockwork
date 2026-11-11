package tracing

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// defaultBatchTimeout is how often completed spans are flushed to the exporter.
const defaultBatchTimeout = 2 * time.Second

// Config carries the OpenTelemetry settings for the process.
type Config struct {
	Enabled          bool
	ExporterEndpoint string
	ServiceName      string
	SamplerRatio     float64
}

// Setup builds and starts the trace SDK: a batch OTLP/gRPC exporter pointed at
// ExporterEndpoint and a TracerProvider with the configured sampling ratio.
// It returns the provider and a shutdown function that flushes and stops the
// exporter. When cfg.Enabled is false a nil provider is returned (callers fall
// back to the no-op tracer), so tracing can be toggled without code changes.
func Setup(cfg Config) (*sdktrace.TracerProvider, func(context.Context) error, error) {
	if !cfg.Enabled {
		return nil, func(context.Context) error { return nil }, nil
	}

	endpoint := cfg.ExporterEndpoint
	if endpoint == "" {
		endpoint = "jaeger:4317"
	}

	exp, err := otlptracegrpc.New(context.Background(),
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}

	res := resource.Default()
	if cfg.ServiceName != "" {
		res = resource.NewSchemaless(semconv.ServiceName(cfg.ServiceName))
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(defaultBatchTimeout)),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SamplerRatio))),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)

	return tp, func(ctx context.Context) error {
		return tp.Shutdown(ctx)
	}, nil
}
