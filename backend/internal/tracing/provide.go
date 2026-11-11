package tracing

import "github.com/Koshsky/erp-backend/internal/config"

// ProvideTracer builds and starts the OpenTelemetry tracer from the app config.
// When tracing is disabled a no-op tracer is returned (Shutdown is a no-op).
func ProvideTracer(cfg config.TracingConfig) (*Tracer, error) {
	return NewTracer(Config{
		Enabled:          cfg.Enabled,
		ExporterEndpoint: cfg.ExporterEndpoint,
		ServiceName:      cfg.ServiceName,
		SamplerRatio:     cfg.SamplerRatio,
	})
}
