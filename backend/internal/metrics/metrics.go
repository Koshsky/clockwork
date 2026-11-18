// Package metrics provides an optional process-local Prometheus registry.
package metrics

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/diagnostics"
)

const (
	maxRequestSeries = 160
	maxRoutes        = 256
	maxRouteLength   = 256
	outcomeSuccess   = "success"
	outcomeTimeout   = "timeout"
	outcomeCanceled  = "canceled"
	overflowLabel    = "other"
)

// Request contains only the access log's safe result metadata.
type Request struct {
	Route    string
	Method   string
	Status   int
	Duration time.Duration
	Panicked bool
}

type requestLabels struct{ route, method, status, outcome string }
type requestSeries struct {
	count    prometheus.Counter
	duration prometheus.Observer
}

// Metrics owns its registry, bounded HTTP series and auxiliary listener. Disabled
// instances allocate no registry and create no listener or background worker.
type Metrics struct {
	cfg          config.MetricsConfig
	logger       *slog.Logger
	registry     *prometheus.Registry
	requests     *prometheus.CounterVec
	duration     *prometheus.HistogramVec
	inflight     prometheus.Gauge
	overflow     prometheus.Counter
	acquisitions *prometheus.CounterVec
	pool         atomic.Pointer[pgxpool.Pool]
	mu           sync.Mutex
	routes       map[string]struct{}
	series       map[requestLabels]requestSeries
	serverMu     sync.Mutex
	server       *http.Server
	listener     net.Listener
}

// New constructs independent instrumentation without a global registry.
func New(cfg config.MetricsConfig, logger *slog.Logger) (*Metrics, error) {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	m := &Metrics{cfg: cfg, logger: logger.With("component", "metrics")}
	if !cfg.Enabled {
		return m, nil
	}
	if err := validateAddress(cfg.Address); err != nil {
		return nil, err
	}
	m.registry = prometheus.NewRegistry()
	m.routes = make(map[string]struct{})
	m.series = make(map[requestLabels]requestSeries)
	labels := []string{"route", "method", "status", "outcome"}
	m.requests = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "clockwork_http_requests_total",
			Help: "Completed application HTTP attempts, excluding probes.",
		},
		labels,
	)
	m.duration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "clockwork_http_request_duration_seconds",
			Help:    "Application HTTP attempt duration, excluding probes.",
			Buckets: []float64{0.01, 0.1, 0.5, 2, 10},
		},
		labels,
	)
	m.inflight = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "clockwork_http_requests_in_flight",
			Help: "Current application HTTP attempts, excluding probes.",
		},
	)
	m.overflow = prometheus.NewCounter(
		prometheus.CounterOpts{
			Name: "clockwork_http_label_overflow_total",
			Help: "Attempts aggregated after the HTTP label budget was reached.",
		},
	)
	m.acquisitions = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "clockwork_db_pool_acquisitions_total",
			Help: "Pool acquisition attempts by controlled outcome.",
		},
		[]string{"outcome"},
	)
	for _, outcome := range []string{outcomeSuccess, outcomeTimeout, outcomeCanceled, "error"} {
		m.acquisitions.WithLabelValues(outcome)
	}
	started := prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "clockwork_process_start_time_seconds",
			Help: "Process instrumentation start time as Unix seconds.",
		},
	)
	started.Set(float64(time.Now().Unix()))
	m.registry.MustRegister(
		m.requests,
		m.duration,
		m.inflight,
		m.overflow,
		m.acquisitions,
		started,
		collectors.NewGoCollector(),
		newPoolCollector(m.pool.Load),
	)
	return m, nil
}

// Enabled reports whether this process explicitly opted into instrumentation.
func (m *Metrics) Enabled() bool { return m != nil && m.cfg.Enabled }

// SetRoutes accepts only application-authored route templates during startup.
// Unmatched URLs never become labels, even when a caller passes one by mistake.
func (m *Metrics) SetRoutes(routes []string) {
	if !m.Enabled() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, route := range routes {
		if len(m.routes) >= maxRoutes {
			break
		}
		if len(route) <= maxRouteLength && strings.HasPrefix(route, "/") && !strings.ContainsAny(route, "?# \r\n\t") {
			m.routes[route] = struct{}{}
		}
	}
}

// Begin marks an application request in flight and reports whether Complete
// must account for it. Registered probes are excluded from application metrics.
func (m *Metrics) Begin(route string) bool {
	if !m.Enabled() || isProbe(route) {
		return false
	}
	m.inflight.Inc()
	return true
}

// Complete records one completed HTTP attempt using the access log's timer.
func (m *Metrics) Complete(ctx context.Context, request Request) {
	if !m.Enabled() {
		return
	}
	defer m.inflight.Dec()
	key := requestLabels{
		route:   request.Route,
		method:  diagnostics.HTTPMethod(request.Method),
		status:  statusLabel(request.Status),
		outcome: httpOutcome(ctx, request.Status, request.Panicked),
	}
	m.mu.Lock()
	if _, ok := m.routes[key.route]; !ok {
		key.route = "unmatched"
	}
	series, ok := m.series[key]
	if !ok {
		if len(m.series) >= maxRequestSeries {
			key = requestLabels{route: overflowLabel, method: "OTHER", status: overflowLabel, outcome: overflowLabel}
			m.overflow.Inc()
		}
		series = m.requestSeries(key)
	}
	m.mu.Unlock()
	series.count.Inc()
	series.duration.Observe(max(0, request.Duration.Seconds()))
}

func (m *Metrics) requestSeries(key requestLabels) requestSeries {
	series, ok := m.series[key]
	if !ok {
		labels := []string{key.route, key.method, key.status, key.outcome}
		series = requestSeries{
			count:    m.requests.WithLabelValues(labels...),
			duration: m.duration.WithLabelValues(labels...),
		}
		m.series[key] = series
	}
	return series
}

func statusLabel(status int) string {
	if status < 100 || status > 599 {
		return overflowLabel
	}
	return strconv.Itoa(status)
}

func isProbe(route string) bool {
	return route == "/api/v1/health" || route == "/api/v1/ready" || route == "/health" || route == "/ready" ||
		route == "/metrics"
}

func httpOutcome(ctx context.Context, status int, panicked bool) string {
	switch {
	case panicked:
		return "panic"
	case ctx.Err() == context.DeadlineExceeded || status == http.StatusRequestTimeout || status == http.StatusGatewayTimeout:
		return outcomeTimeout
	case ctx.Err() == context.Canceled:
		return outcomeCanceled
	case status == http.StatusTooManyRequests:
		return "rate_limited"
	case status >= http.StatusInternalServerError:
		return "server_error"
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return "denied"
	case status == http.StatusConflict:
		return "conflict"
	case status == http.StatusNotFound:
		return "not_found"
	case status >= http.StatusBadRequest:
		return "validation"
	case status >= http.StatusMultipleChoices:
		return "redirect"
	default:
		return outcomeSuccess
	}
}
