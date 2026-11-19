//nolint:testpackage // measures the production middleware chain without starting an application server.
package server

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	runtimemetrics "runtime/metrics"
	"slices"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	loggerpkg "github.com/Koshsky/erp-backend/internal/logger"
	"github.com/Koshsky/erp-backend/internal/metrics"
	tracingmw "github.com/Koshsky/erp-backend/internal/middleware/tracing"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

// This opt-in workload reports raw variability rather than adding a flaky latency CI gate.
func TestObservabilityBudget(t *testing.T) {
	t.Parallel()
	if os.Getenv("CLOCKWORK_DIAGNOSTICS_BUDGET") != "1" {
		t.Skip("explicit local HTTP budget workload")
	}
	runtime.GC()
	var initial, initialized runtime.MemStats
	runtime.ReadMemStats(&initial)
	routers, shutdown := budgetRouters(t)
	runtime.GC()
	runtime.ReadMemStats(&initialized)
	extra := int64(initialized.HeapAlloc) - int64(initial.HeapAlloc)
	t.Logf("budget initialization_live_heap_extra_bytes=%d (includes all routers and business fixture)", extra)
	if extra > 32*1024*1024 {
		t.Error("diagnostic initialization plus fixture exceeds 32 MiB")
	}
	t.Cleanup(shutdown)
	results := make([][]budgetObservation, len(routers))
	for pass := range 5 {
		for offset := range routers {
			index := (offset + pass) % len(routers)
			results[index] = append(results[index], measureBudget(routers[index]))
		}
	}
	baseline := budgetMedian(results[0])
	for index, name := range []string{"baseline", "local", "optional"} {
		value := budgetMedian(results[index])
		growth := 100 * (float64(value.p95)/float64(baseline.p95) - 1)
		cpuPoints := 100 * (value.cpuPerRequest - baseline.cpuPerRequest) * 10
		t.Logf(
			"budget mode=%s p95_us=%.3f p95_change_percent=%.3f cpu_extra_at_10rps_percent=%.4f peak_heap_bytes=%d",
			name,
			float64(value.p95)/1000,
			growth,
			cpuPoints,
			value.peakHeap,
		)
		t.Logf("budget mode=%s raw=%+v", name, results[index])
		if value.peakHeap > baseline.peakHeap+32*1024*1024 {
			t.Error("additional backend heap exceeds 32 MiB")
		}
		if cpuPoints > 3 {
			t.Error("additional CPU exceeds three percent of one core at the stated rate")
		}
	}
}

func budgetRouters(t *testing.T) ([]*gin.Engine, func()) {
	t.Helper()
	logger := loggerpkg.WithRelease(
		slog.New(loggerpkg.NewContextHandler(slog.NewJSONHandler(budgetSink{}, nil))),
		"1.6.0",
	)
	provider, shutdown, err := tracing.Setup(
		tracing.Config{
			Enabled:          true,
			ExporterEndpoint: "127.0.0.1:9",
			Insecure:         true,
			SamplerRatio:     0.1,
			ServiceName:      "budget-fixture",
			Logger:           logger,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	rows := make([]map[string]any, 2000)
	for index := range rows {
		rows[index] = map[string]any{
			"id":         index + 1,
			"process_id": 1,
			"title":      "Synthetic planning fixture",
			"start_date": "2026-11-01",
			"end_date":   "2026-12-31",
			"color":      "#238675",
			"resources":  []int{1, 2, 3},
		}
	}
	payload := gin.H{"data": gin.H{"processes": []gin.H{{"id": 1, "tasks": rows}}}, "error": gin.H{}}
	routers := make([]*gin.Engine, 0, 3)
	for _, mode := range []string{"baseline", "local", "optional"} {
		meter, meterErr := metrics.New(
			config.MetricsConfig{Enabled: mode == "optional", Address: "127.0.0.1:0"},
			logger,
		)
		if meterErr != nil {
			t.Fatal(meterErr)
		}
		meter.SetRoutes([]string{"/planning/tasks"})
		tracer := tracing.New(nil)
		if mode == "optional" {
			tracer = tracing.New(provider)
		}
		application := &App{logger: logger, tracer: tracer, metrics: meter}
		router := gin.New()
		if mode != "baseline" {
			router.Use(
				application.requestID(),
				tracingmw.HTTPRootSpan(tracer),
				application.requestLog(),
				application.recovery(),
			)
		}
		router.GET("/planning/tasks", func(c *gin.Context) { c.JSON(http.StatusOK, payload) })
		routers = append(routers, router)
	}
	return routers, func() { _ = shutdown(context.Background()) }
}

type budgetObservation struct {
	p95           time.Duration
	cpuPerRequest float64
	peakHeap      uint64
}

func budgetCPU() float64 {
	values := []runtimemetrics.Sample{
		{Name: "/cpu/classes/user:cpu-seconds"},
		{Name: "/cpu/classes/gc/total:cpu-seconds"},
	}
	runtimemetrics.Read(values)
	return values[0].Value.Float64() + values[1].Value.Float64()
}

func measureBudget(router *gin.Engine) budgetObservation {
	const requests = 300
	for range 20 {
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/planning/tasks", nil))
	}
	runtime.GC()
	startCPU := budgetCPU()
	samples := make([]time.Duration, 0, requests)
	var memory runtime.MemStats
	var peak uint64
	for index := range requests {
		request := httptest.NewRequest(http.MethodGet, "/planning/tasks", nil)
		response := httptest.NewRecorder()
		start := time.Now()
		router.ServeHTTP(response, request)
		samples = append(samples, time.Since(start))
		if index%25 == 0 {
			runtime.ReadMemStats(&memory)
			peak = max(peak, memory.HeapAlloc)
		}
	}
	cpu := budgetCPU() - startCPU
	slices.Sort(samples)
	return budgetObservation{p95: samples[len(samples)*95/100], cpuPerRequest: cpu / requests, peakHeap: peak}
}

func budgetMedian(values []budgetObservation) budgetObservation {
	p95 := make([]time.Duration, 0, len(values))
	cpu := make([]float64, 0, len(values))
	heaps := make([]uint64, 0, len(values))
	for _, value := range values {
		p95 = append(p95, value.p95)
		cpu = append(cpu, value.cpuPerRequest)
		heaps = append(heaps, value.peakHeap)
	}
	slices.Sort(p95)
	slices.Sort(cpu)
	slices.Sort(heaps)
	return budgetObservation{p95: p95[len(p95)/2], cpuPerRequest: cpu[len(cpu)/2], peakHeap: heaps[len(heaps)/2]}
}

// budgetSink exercises real JSON encoding while keeping benchmark fixtures off disk.
type budgetSink struct{}

func (budgetSink) Write(value []byte) (int, error) { return len(value), nil }
