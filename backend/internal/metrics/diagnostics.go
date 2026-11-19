package metrics

import (
	"github.com/prometheus/client_golang/prometheus"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
)

type auditReader func() diagnostics.AuditStatus

// AttachOutcomes exports existing local observations only when metrics are enabled.
func (m *Metrics) AttachOutcomes(source *diagnostics.Outcomes) {
	if m.Enabled() {
		m.outcomes.Store(source)
	}
}

// AttachAudit binds a read-only safe snapshot, never an event queue or network call.
func (m *Metrics) AttachAudit(read func() diagnostics.AuditStatus) {
	if m.Enabled() {
		r := auditReader(read)
		m.audit.Store(&r)
	}
}

type diagnosticsCollector struct {
	outcomes func() *diagnostics.Outcomes
	audit    func() *auditReader
	outcome  *prometheus.Desc
	queues   []*prometheus.Desc
	flags    []*prometheus.Desc
}

func newDiagnosticsCollector(m *Metrics) *diagnosticsCollector {
	c := &diagnosticsCollector{
		outcomes: m.outcomes.Load,
		audit:    m.audit.Load,
		outcome: prometheus.NewDesc(
			"clockwork_outcomes_total",
			"Observed boundary outcomes; accepted commits exclude replay/receipt confirmations.",
			[]string{"stage", outcomeLabel},
			nil,
		),
	}
	for _, spec := range []struct{ name, help string }{
		{"pending", "Events queued for delivery."}, {"in_flight", "Events currently being sent."}, {"oldest_age_seconds", "Age of the oldest queued event; zero when empty."},
		{"enqueued_total", "Events accepted by this sender."}, {"delivered_total", "Events whose send returned success."}, {"attempts_total", "Network send attempts."}, {"retries_total", "Additional asynchronous send attempts."},
		{"overflow_total", "Events rejected by full buffers."}, {"exhausted_total", "Events with exhausted async retry budgets."}, {"inline_failures_total", "Failed single synchronous attempts."}, {"after_stop_total", "Events rejected after asynchronous shutdown began."},
		{"last_shutdown_pending", "Unconfirmed events observed at the latest shutdown timeout; not a loss counter."},
	} {
		c.queues = append(c.queues, prometheus.NewDesc("clockwork_audit_"+spec.name, spec.help, []string{"queue"}, nil))
	}
	for _, name := range []string{"enabled", "sync", "stopped"} {
		c.flags = append(
			c.flags,
			prometheus.NewDesc("clockwork_audit_"+name, "Audit sender operating state.", nil, nil),
		)
	}
	return c
}

func (c *diagnosticsCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.outcome
	for _, d := range c.queues {
		ch <- d
	}
	for _, d := range c.flags {
		ch <- d
	}
}

func (c *diagnosticsCollector) Collect(ch chan<- prometheus.Metric) {
	for _, v := range c.outcomes().Snapshot() {
		ch <- prometheus.MustNewConstMetric(c.outcome, prometheus.CounterValue, float64(v.Total), string(v.Stage), string(v.Outcome))
	}
	reader := c.audit()
	if reader == nil || *reader == nil {
		return
	}
	status := (*reader)()
	for i, value := range []bool{status.Enabled, status.Sync, status.Stopped} {
		var n float64
		if value {
			n = 1
		}
		ch <- prometheus.MustNewConstMetric(c.flags[i], prometheus.GaugeValue, n)
	}
	for _, q := range status.Queues {
		if !q.Queue.Valid() {
			continue
		}
		c.collectQueue(ch, q)
	}
}

func (c *diagnosticsCollector) collectQueue(ch chan<- prometheus.Metric, q diagnostics.AuditQueueStatus) {
	values := []float64{
		float64(q.Pending),
		float64(q.InFlight),
		float64(q.OldestAgeMS) / 1000,
		float64(q.Enqueued),
		float64(q.Delivered),
		float64(q.Attempts),
		float64(q.Retries),
		float64(q.Overflow),
		float64(q.Exhausted),
		float64(q.InlineFailures),
		float64(q.AfterStop),
		float64(q.LastShutdownPending),
	}
	const firstCounter = 3
	for i, d := range c.queues {
		kind := prometheus.GaugeValue
		if i >= firstCounter && i < len(values)-1 {
			kind = prometheus.CounterValue
		}
		ch <- prometheus.MustNewConstMetric(d, kind, values[i], string(q.Queue))
	}
}
