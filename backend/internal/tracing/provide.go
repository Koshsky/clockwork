package tracing

import (
	"log/slog"

	release "github.com/Koshsky/erp-backend"
	"github.com/Koshsky/erp-backend/internal/config"
)

// ProvideTracer builds and starts the OpenTelemetry tracer from the app config.
// When tracing is disabled a no-op tracer is returned (Shutdown is a no-op).
func ProvideTracer(cfg config.TracingConfig, version string, logger *slog.Logger) (*Tracer, error) {
	return NewTracer(Config{
		Enabled:          cfg.Enabled,
		ExporterEndpoint: cfg.ExporterEndpoint,
		ServiceName:      cfg.ServiceName,
		ServiceVersion:   release.NewInfo(version).Version,
		Insecure:         cfg.Insecure,
		CAFile:           cfg.CAFile,
		AuthToken:        cfg.AuthToken,
		Logger:           logger,
		SamplerRatio:     cfg.SamplerRatio,
	})
}
