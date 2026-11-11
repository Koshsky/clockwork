// Package profiler runs a standalone pprof server.
package profiler

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
)

const (
	defaultHeaderReadTimeout = 5 * time.Second
)

// Profiler serves pprof endpoints on its own HTTP server.
type Profiler struct {
	cfg    config.ProfilingConfig
	logger *slog.Logger
	server *http.Server
}

// New builds the profiler.
func New(cfg config.ProfilingConfig, logger *slog.Logger) *Profiler {
	return &Profiler{cfg: cfg, logger: logger.With("component", "profiler")}
}

// Start launches the pprof server if profiling is enabled.
func (p *Profiler) Start() {
	if !p.cfg.Enabled {
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	p.server = &http.Server{
		Addr:              p.cfg.Address,
		Handler:           mux,
		ReadHeaderTimeout: defaultHeaderReadTimeout,
	}

	go func() {
		p.logger.Info("starting profiler", "addr", p.server.Addr)
		if err := p.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			p.logger.Error("profiler server error", "error", err)
		}
	}()
}

// Stop gracefully shuts down the pprof server.
func (p *Profiler) Stop(ctx context.Context) error {
	if p.server == nil {
		return nil
	}
	return p.server.Shutdown(ctx)
}
