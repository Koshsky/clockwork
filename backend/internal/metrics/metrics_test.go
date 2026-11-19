package metrics_test

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"

	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/diagnostics"
	"github.com/Koshsky/erp-backend/internal/metrics"
)

func enabledMetrics(t testing.TB) *metrics.Metrics {
	t.Helper()
	m, err := metrics.New(config.MetricsConfig{Enabled: true, Address: "127.0.0.1:0"}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func scrape(t testing.TB, m *metrics.Metrics) map[string]*dto.MetricFamily {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	response := httptest.NewRecorder()
	m.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("scrape status: %d", response.Code)
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	families, err := parser.TextToMetricFamilies(strings.NewReader(response.Body.String()))
	if err != nil {
		t.Fatal(err)
	}
	return families
}

func record(m *metrics.Metrics, route, method string, status int) {
	if m.Begin(route) {
		m.Complete(
			context.Background(),
			metrics.Request{Route: route, Method: method, Status: status, Duration: 20 * time.Millisecond},
		)
	}
}

func label(metric *dto.Metric, key string) string {
	for _, pair := range metric.GetLabel() {
		if pair.GetName() == key {
			return pair.GetValue()
		}
	}
	return ""
}

func sumCounters(family *dto.MetricFamily) float64 {
	var sum float64
	for _, metric := range family.GetMetric() {
		sum += metric.GetCounter().GetValue()
	}
	return sum
}

func TestRequestsHaveMatchingCountsDurationsAndInflight(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	m.SetRoutes([]string{"/tasks/:id"})
	if !m.Begin("/tasks/:id") {
		t.Fatal("application request excluded")
	}
	initial := scrape(t, m)
	if initial["clockwork_http_requests_in_flight"].GetMetric()[0].GetGauge().GetValue() != 1 {
		t.Fatal("request not in flight")
	}
	m.Complete(
		t.Context(),
		metrics.Request{Route: "/tasks/:id", Method: http.MethodGet, Status: 200, Duration: 20 * time.Millisecond},
	)
	values := scrape(t, m)
	count := values["clockwork_http_requests_total"].GetMetric()
	hist := values["clockwork_http_request_duration_seconds"].GetMetric()[0].GetHistogram()
	if len(count) != 1 || count[0].GetCounter().GetValue() != 1 || label(count[0], "route") != "/tasks/:id" ||
		label(
			count[0],
			"method",
		) != "GET" || label(count[0], "status") != "200" || label(count[0], "outcome") != "success" ||
		hist.GetSampleCount() != 1 || math.Abs(hist.GetSampleSum()-0.02) > 0.000001 || len(hist.GetBucket()) != 6 {
		t.Fatal("completed request counter/histogram disagreed")
	}
	if values["clockwork_http_requests_in_flight"].GetMetric()[0].GetGauge().GetValue() != 0 {
		t.Fatal("request remained in flight")
	}
	for _, name := range []string{"go_goroutines", "go_memstats_alloc_bytes", "go_gc_duration_seconds", "clockwork_process_start_time_seconds"} {
		if values[name] == nil {
			t.Fatalf("missing runtime metric %s", name)
		}
	}
}

func TestObjectIDsUnknownURLsAndMethodsCannotGrowSeries(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	m.SetRoutes([]string{"/tasks/:id"})
	for i := range 3000 {
		record(m, "/tasks/:id", "GET", 200)
		record(m, fmt.Sprintf("/canary-user-%d?token=canary-secret", i), fmt.Sprintf("canary-method-%d", i), 404)
	}
	values := scrape(t, m)
	counts := values["clockwork_http_requests_total"].GetMetric()
	if len(counts) != 2 || sumCounters(values["clockwork_http_requests_total"]) != 6000 {
		t.Fatalf("dynamic input grew series: %d", len(counts))
	}
	for _, metric := range counts {
		for _, pair := range metric.GetLabel() {
			if strings.Contains(pair.GetValue(), "canary") {
				t.Fatal("request data escaped into metric labels")
			}
		}
	}
}

func TestCardinalityBudgetAggregatesWithoutLosingCounts(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	var routes []string
	for i := range 1000 {
		routes = append(routes, fmt.Sprintf("/route-%d", i))
	}
	m.SetRoutes(routes)
	for i := range 1000 {
		record(m, routes[i], "GET", 200)
	}
	values := scrape(t, m)
	if sumCounters(values["clockwork_http_requests_total"]) != 1000 ||
		values["clockwork_http_label_overflow_total"].GetMetric()[0].GetCounter().GetValue() == 0 {
		t.Fatal("overflow lost observations or was not visible")
	}
	samples := metricSampleCount(t, values)
	if samples > 2000 {
		t.Fatalf("sample budget exceeded: %d", samples)
	}
	t.Logf("maximum observed sample count: %d", samples)
}

func TestRegisteredProbesDoNotAffectApplicationSLI(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	for _, route := range []string{"/api/v1/health", "/api/v1/ready", "/health", "/ready", "/metrics"} {
		for _, status := range []int{200, 503} {
			record(m, route, "GET", status)
		}
	}
	values := scrape(t, m)
	if sumCounters(values["clockwork_http_requests_total"]) != 0 ||
		values["clockwork_http_requests_in_flight"].GetMetric()[0].GetGauge().GetValue() != 0 {
		t.Fatal("probes contaminated application SLI")
	}
}

func TestConcurrentRequestsAndScrapesAreConsistent(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	m.SetRoutes([]string{"/tasks/:id"})
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			for range 100 {
				record(m, "/tasks/:id", "PATCH", 200)
			}
		})
	}
	for range 8 {
		scrape(t, m)
	}
	group.Wait()
	values := scrape(t, m)
	if sumCounters(values["clockwork_http_requests_total"]) != 800 ||
		values["clockwork_http_requests_in_flight"].GetMetric()[0].GetGauge().GetValue() != 0 {
		t.Fatal("concurrent observations were duplicated/lost")
	}
}

func TestNewRegistryResetsCountersWithoutGlobalRegistration(t *testing.T) {
	t.Parallel()
	first := enabledMetrics(t)
	first.SetRoutes([]string{"/tasks/:id"})
	record(first, "/tasks/:id", "POST", 201)
	second := enabledMetrics(t)
	if sumCounters(scrape(t, first)["clockwork_http_requests_total"]) != 1 ||
		sumCounters(scrape(t, second)["clockwork_http_requests_total"]) != 0 {
		t.Fatal("process registries shared counter state")
	}
}

func BenchmarkHTTPMetrics(b *testing.B) {
	for _, enabled := range []bool{false, true} {
		b.Run(strconv.FormatBool(enabled), func(b *testing.B) {
			m, err := metrics.New(config.MetricsConfig{Enabled: enabled, Address: "127.0.0.1:0"}, nil)
			if err != nil {
				b.Fatal(err)
			}
			m.SetRoutes([]string{"/tasks/:id"})
			record(m, "/tasks/:id", "GET", 200)
			b.ReportAllocs()
			for b.Loop() {
				record(m, "/tasks/:id", "GET", 200)
			}
		})
	}
}

func TestLocalOutcomesAndAuditExportUseOnlyControlledBoundedLabels(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	counts := diagnostics.NewOutcomes()
	ctx := diagnostics.WithOutcomes(t.Context(), counts)
	diagnostics.Record(ctx, nil, diagnostics.Durable, diagnostics.Accepted, nil)
	diagnostics.Record(ctx, nil, diagnostics.Durable, diagnostics.Replayed, nil)
	diagnostics.Record(ctx, nil, diagnostics.Receipt, diagnostics.Confirmed, nil)
	m.AttachOutcomes(counts)
	m.AttachAudit(func() diagnostics.AuditStatus {
		return diagnostics.AuditStatus{
			Enabled: true,
			Queues: [2]diagnostics.AuditQueueStatus{
				{Queue: diagnostics.Regular, Pending: 2, Attempts: 3, Retries: 2, Delivered: 1, OldestAgeMS: 2500},
				{Queue: diagnostics.Critical, Overflow: 1},
			},
		}
	})
	values := scrape(t, m)
	if sumCounters(values["clockwork_outcomes_total"]) != 3 ||
		len(values["clockwork_outcomes_total"].GetMetric()) != 3 {
		t.Fatal("replay/receipt outcomes were lost or merged into accepted")
	}
	if len(values["clockwork_audit_pending"].GetMetric()) != 2 ||
		sumCounters(values["clockwork_audit_retries_total"]) != 2 {
		t.Fatal("safe audit status missing from optional metrics")
	}
}

func metricSampleCount(t testing.TB, values map[string]*dto.MetricFamily) int {
	t.Helper()
	samples := 0
	for _, family := range values {
		for _, metric := range family.GetMetric() {
			switch family.GetType() {
			case dto.MetricType_HISTOGRAM, dto.MetricType_GAUGE_HISTOGRAM:
				samples += len(metric.GetHistogram().GetBucket()) + 2
			case dto.MetricType_SUMMARY:
				samples += len(metric.GetSummary().GetQuantile()) + 2
			case dto.MetricType_COUNTER, dto.MetricType_GAUGE, dto.MetricType_UNTYPED:
				samples++
			default:
				t.Fatalf("unexpected metric type %v", family.GetType())
			}
		}
	}
	return samples
}

func TestCombinedHTTPOutcomeAndAuditBudgetStaysBelowTwoThousand(t *testing.T) {
	t.Parallel()
	m := enabledMetrics(t)
	var routes []string
	for i := range 200 {
		routes = append(routes, fmt.Sprintf("/budget-%d", i))
	}
	m.SetRoutes(routes)
	for _, route := range routes {
		record(m, route, "GET", 200)
	}
	counts := diagnostics.NewOutcomes()
	ctx := diagnostics.WithOutcomes(t.Context(), counts)
	for _, stage := range []diagnostics.Stage{diagnostics.Durable, diagnostics.Legacy, diagnostics.Receipt, diagnostics.Revision, diagnostics.Rollback, diagnostics.Migration, diagnostics.RBAC, diagnostics.Planning, diagnostics.Calendar} {
		for _, outcome := range []diagnostics.Outcome{diagnostics.Accepted, diagnostics.Replayed, diagnostics.Confirmed, diagnostics.InProgress, diagnostics.NotFound, diagnostics.Conflict, diagnostics.Rejected, diagnostics.Unknown, diagnostics.RolledBack, diagnostics.Failed, diagnostics.Ready, diagnostics.Canceled} {
			diagnostics.Record(ctx, nil, stage, outcome, nil)
		}
	}
	m.AttachOutcomes(counts)
	m.AttachAudit(func() diagnostics.AuditStatus {
		return diagnostics.AuditStatus{
			Queues: [2]diagnostics.AuditQueueStatus{{Queue: diagnostics.Regular}, {Queue: diagnostics.Critical}},
		}
	})
	values := scrape(t, m)
	samples := metricSampleCount(t, values)
	if samples > 2000 {
		t.Fatalf("combined series budget exceeded: %d", samples)
	}
	t.Logf("combined worst-case series: %d", samples)
}
