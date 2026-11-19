package tracing

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"

	errinternal "github.com/Koshsky/erp-backend/internal/errors"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

// Fixed process limits cannot be raised by ambient OTEL_* settings.
const (
	defaultBatchTimeout = 2 * time.Second
	exportTimeout       = 3 * time.Second
	shutdownTimeout     = 5 * time.Second
	maxQueuedSpans      = 512
	maxBatchSpans       = 64
	maxSpanAttributes   = 16
	maxAttributeLength  = 256
	maxSpanEvents       = 4
	maxSpanLinks        = 4
)

// Config carries explicitly selected OpenTelemetry settings for the process.
type Config struct {
	Enabled          bool
	ExporterEndpoint string
	ServiceName      string
	ServiceVersion   string
	SamplerRatio     float64
	Insecure         bool
	CAFile           string
	AuthToken        string
	Logger           *slog.Logger
}

// Setup enables best-effort OTLP export without waiting for a receiver. Disabled
// tracing does not validate exporter settings, read CA files or open connections.
func Setup(cfg Config) (*sdktrace.TracerProvider, func(context.Context) error, error) {
	if !cfg.Enabled {
		return nil, func(context.Context) error { return nil }, nil
	}
	if math.IsNaN(cfg.SamplerRatio) || math.IsInf(cfg.SamplerRatio, 0) || cfg.SamplerRatio < 0 || cfg.SamplerRatio > 1 {
		return nil, nil, fmt.Errorf("tracing sampler_ratio must be between 0 and 1: %w", errinternal.ErrConfiguration)
	}
	installErrorHandler(cfg.Logger)
	exp, closeExporter, err := newExporter(cfg)
	if err != nil {
		return nil, nil, err
	}
	tp := newProvider(cfg, exp)
	return tp, func(ctx context.Context) error {
		ctx, cancel := context.WithTimeout(ctx, shutdownTimeout)
		defer cancel()
		defer closeExporter()
		return tp.Shutdown(ctx)
	}, nil
}

func newProvider(cfg Config, exp sdktrace.SpanExporter) *sdktrace.TracerProvider {
	ratio := sdktrace.TraceIDRatioBased(cfg.SamplerRatio)
	return sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp,
			sdktrace.WithBatchTimeout(defaultBatchTimeout),
			sdktrace.WithExportTimeout(exportTimeout),
			sdktrace.WithMaxQueueSize(maxQueuedSpans),
			sdktrace.WithMaxExportBatchSize(maxBatchSpans)),
		sdktrace.WithSampler(sdktrace.ParentBased(ratio,
			sdktrace.WithRemoteParentSampled(ratio), sdktrace.WithRemoteParentNotSampled(ratio))),
		sdktrace.WithResource(traceResource(cfg.ServiceName, cfg.ServiceVersion)),
		sdktrace.WithRawSpanLimits(sdktrace.SpanLimits{
			AttributeValueLengthLimit: maxAttributeLength, AttributeCountLimit: maxSpanAttributes,
			EventCountLimit: maxSpanEvents, LinkCountLimit: maxSpanLinks,
			AttributePerEventCountLimit: maxSpanAttributes, AttributePerLinkCountLimit: maxSpanAttributes,
		}),
	)
}

// The SDK's default error handler prints receiver-controlled error messages.
// This process owns OTel initialization; retain only a controlled diagnostic code.
func installErrorHandler(logger *slog.Logger) {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	logger = logger.With("component", "tracing")
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(_ error) {
		logger.WarnContext(context.Background(), "trace export failed", "error_code", errapi.CodeInternal)
	}))
}

func traceResource(serviceName, version string) *resource.Resource {
	if serviceName == "" {
		serviceName = "erp-backend"
	}
	return resource.NewSchemaless(semconv.ServiceName(serviceName), semconv.ServiceVersion(version))
}
