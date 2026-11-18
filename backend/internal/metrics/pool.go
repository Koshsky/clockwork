package metrics

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// AttachPool publishes pool statistics without querying the database on scrapes.
func (m *Metrics) AttachPool(pool *pgxpool.Pool) {
	if m.Enabled() {
		m.pool.Store(pool)
	}
}

// PoolAcquire observes pgx's single acquire completion hook. CanceledAcquireCount
// alone conflates cancellation and timeout, so these outcomes are counted here.
func (m *Metrics) PoolAcquire(ctx context.Context, err error) {
	if !m.Enabled() {
		return
	}
	outcome := outcomeSuccess
	switch {
	case err == nil:
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded:
		outcome = outcomeTimeout
	case errors.Is(err, context.Canceled) || ctx.Err() == context.Canceled:
		outcome = outcomeCanceled
	default:
		outcome = "error"
	}
	m.acquisitions.WithLabelValues(outcome).Inc()
}

type poolCollector struct {
	pool         func() *pgxpool.Pool
	descriptions []*prometheus.Desc
}

func newPoolCollector(pool func() *pgxpool.Pool) *poolCollector {
	names := []struct{ name, help string }{
		{"available", "Whether an application pool is attached; not a database health check."},
		{"acquired_connections", "Connections currently acquired."},
		{"idle_connections", "Connections currently idle."},
		{"total_connections", "Total pool connections."},
		{"max_connections", "Configured pool capacity."},
		{"acquires_total", "Successful pool acquires."},
		{"acquire_seconds_total", "Time spent in successful acquires, including uncontended acquires."},
		{"waits_total", "Successful acquires that waited for a resource."},
		{"wait_seconds_total", "Time spent waiting in successful contended acquires."},
		{"canceled_acquires_total", "Canceled pool acquires, including timeouts."},
	}
	collector := &poolCollector{pool: pool}
	for _, spec := range names {
		collector.descriptions = append(
			collector.descriptions,
			prometheus.NewDesc("clockwork_db_pool_"+spec.name, spec.help, nil, nil),
		)
	}
	return collector
}

func (p *poolCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range p.descriptions {
		ch <- desc
	}
}

func (p *poolCollector) Collect(ch chan<- prometheus.Metric) {
	values := make([]float64, len(p.descriptions))
	if pool := p.pool(); pool != nil {
		stat := pool.Stat()
		values = []float64{
			1,
			float64(stat.AcquiredConns()),
			float64(stat.IdleConns()),
			float64(stat.TotalConns()),
			float64(stat.MaxConns()),
			float64(stat.AcquireCount()),
			stat.AcquireDuration().Seconds(),
			float64(stat.EmptyAcquireCount()),
			stat.EmptyAcquireWaitTime().Seconds(),
			float64(stat.CanceledAcquireCount()),
		}
	}
	const firstCounter = 5
	for i, desc := range p.descriptions {
		kind := prometheus.GaugeValue
		if i >= firstCounter {
			kind = prometheus.CounterValue
		}
		ch <- prometheus.MustNewConstMetric(desc, kind, values[i])
	}
}
