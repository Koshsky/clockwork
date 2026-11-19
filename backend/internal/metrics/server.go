package metrics

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	errinternal "github.com/Koshsky/erp-backend/internal/errors"
)

const (
	scrapeTimeout  = 3 * time.Second
	headerTimeout  = 2 * time.Second
	writeTimeout   = 5 * time.Second
	maxHeaderBytes = 8 * 1024
)

func privateIP(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

func validateAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	_, portErr := strconv.ParseUint(port, 10, 16)
	if err != nil || portErr != nil || !privateIP(host) {
		return fmt.Errorf(
			"metrics address must use a literal loopback/private IP and port: %w",
			errinternal.ErrConfiguration,
		)
	}
	return nil
}

// Handler is isolated from user sessions, the application router and default mux.
// Only private direct peers may scrape; forwarding headers are never trusted.
func (m *Metrics) Handler() http.Handler {
	if !m.Enabled() {
		return http.NotFoundHandler()
	}
	mux := http.NewServeMux()
	mux.Handle(
		"GET /metrics",
		promhttp.HandlerFor(
			m.registry,
			promhttp.HandlerOpts{DisableCompression: true, MaxRequestsInFlight: 1, Timeout: scrapeTimeout},
		),
	)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !privateIP(host) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// Start binds only the explicitly selected private address. A bind error is
// returned for local logging; the application can keep serving business traffic.
func (m *Metrics) Start() error {
	if !m.Enabled() {
		return nil
	}
	m.serverMu.Lock()
	defer m.serverMu.Unlock()
	if m.server != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), headerTimeout)
	defer cancel()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", m.cfg.Address)
	if err != nil {
		return fmt.Errorf("listen for metrics: %w", err)
	}
	m.listener = listener
	m.server = &http.Server{
		Addr:              listener.Addr().String(),
		Handler:           m.Handler(),
		ReadHeaderTimeout: headerTimeout,
		ReadTimeout:       scrapeTimeout,
		WriteTimeout:      writeTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
	}
	server := m.server
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && serveErr != http.ErrServerClosed {
			m.logger.WarnContext(context.Background(), "metrics listener stopped", "error", serveErr)
		}
	}()
	return nil
}

// Address returns the actual bound address, or empty when no listener exists.
func (m *Metrics) Address() string {
	if m == nil {
		return ""
	}
	m.serverMu.Lock()
	defer m.serverMu.Unlock()
	if m.server == nil {
		return ""
	}
	return m.server.Addr
}

// Stop gracefully stops the optional listener without stopping the business API.
func (m *Metrics) Stop(ctx context.Context) error {
	if m == nil {
		return nil
	}
	m.serverMu.Lock()
	server := m.server
	listener := m.listener
	m.serverMu.Unlock()
	if server == nil {
		return nil
	}
	err := server.Shutdown(ctx)
	_ = listener.Close()
	return err
}
