package profiler

import (
	"log/slog"

	"github.com/Koshsky/erp-backend/internal/config"
)

// ProvideProfiler builds the pprof server.
func ProvideProfiler(cfg config.ProfilingConfig, logger *slog.Logger) *Profiler {
	return New(cfg, logger)
}
