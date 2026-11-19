//nolint:testpackage // exercise fixed SDK bounds without exposing production configuration knobs.
package tracing

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	errinternal "github.com/Koshsky/erp-backend/internal/errors"
)

//nolint:paralleltest // Setup owns the process-wide SDK error handler.
func TestSetupRejectsInvalidExportSettings(t *testing.T) {
	preserveOTelHandler(t)
	brokenCA := filepath.Join(t.TempDir(), "canary-ca.pem")
	if err := os.WriteFile(brokenCA, []byte("canary-not-a-certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name      string
		configure func(*Config)
	}{
		{"missing endpoint", func(c *Config) { c.ExporterEndpoint = "" }},
		{"URL with credentials", func(c *Config) { c.ExporterEndpoint = "https://canary-token@example.com:4317" }},
		{"path", func(c *Config) { c.ExporterEndpoint = "example.com:4317/traces" }},
		{"query", func(c *Config) { c.ExporterEndpoint = "example.com?token=canary:4317" }},
		{"resolver scheme", func(c *Config) { c.ExporterEndpoint = "dns:///example.com:4317" }},
		{"control in host", func(c *Config) { c.ExporterEndpoint = "canary\x00-host:4317" }},
		{"invalid CA", func(c *Config) { c.CAFile = brokenCA }},
		{"missing host", func(c *Config) { c.ExporterEndpoint = ":4317" }},
		{"invalid port", func(c *Config) { c.ExporterEndpoint = "localhost:65536" }},
		{"zero port", func(c *Config) { c.ExporterEndpoint = "localhost:0" }},
		{"negative sampling", func(c *Config) { c.SamplerRatio = -1 }},
		{"excessive sampling", func(c *Config) { c.SamplerRatio = 2 }},
		{"NaN sampling", func(c *Config) { c.SamplerRatio = math.NaN() }},
		{"infinite sampling", func(c *Config) { c.SamplerRatio = math.Inf(1) }},
		{"token over plaintext", func(c *Config) { c.Insecure = true; c.AuthToken = "canary-token" }},
		{"CA over plaintext", func(c *Config) { c.Insecure = true; c.CAFile = "canary-file" }},
		{"token newline", func(c *Config) { c.AuthToken = "canary\n-token" }},
		{"excessive token", func(c *Config) { c.AuthToken = strings.Repeat("canary", maxTokenLength) }},
		{"missing CA", func(c *Config) { c.CAFile = "/missing/canary-file.pem" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Config{Enabled: true, ExporterEndpoint: "localhost:4317", SamplerRatio: 1}
			tc.configure(&cfg)
			provider, shutdown, err := Setup(cfg)
			if !errors.Is(err, errinternal.ErrConfiguration) || provider != nil || shutdown != nil {
				t.Fatalf("invalid configuration was accepted: %v", err)
			}
			if strings.Contains(err.Error(), "canary") {
				t.Fatal("configuration error exposed a secret/path")
			}
		})
	}
}

func TestFixedSpanLimitsAndLocalSampling(t *testing.T) {
	t.Parallel()
	for _, ratio := range []float64{0, 1} {
		t.Run(fmt.Sprint(ratio), func(t *testing.T) {
			t.Parallel()
			exporter := tracetest.NewInMemoryExporter()
			provider := newProvider(Config{SamplerRatio: ratio}, exporter)
			defer func() { _ = provider.Shutdown(context.Background()) }()
			remote := trace.NewSpanContext(trace.SpanContextConfig{
				TraceID: trace.TraceID{1}, SpanID: trace.SpanID{1}, TraceFlags: trace.FlagsSampled, Remote: true,
			})
			ctx, root := provider.Tracer("test").
				Start(trace.ContextWithRemoteSpanContext(t.Context(), remote), "request")
			_, child := provider.Tracer("test").Start(ctx, "service")
			for i := range maxSpanAttributes + 5 {
				child.SetAttributes(attribute.String(strconv.Itoa(i), strings.Repeat("x", maxAttributeLength+1)))
				child.AddEvent("event")
			}
			child.End()
			root.End()
			if err := provider.ForceFlush(t.Context()); err != nil {
				t.Fatal(err)
			}
			spans := exporter.GetSpans()
			if ratio == 0 {
				if len(spans) != 0 {
					t.Fatal("remote sampled flag bypassed local sampling")
				}
				return
			}
			if len(spans) != 2 || spans[0].Parent.SpanID() != spans[1].SpanContext.SpanID() {
				t.Fatal("in-process child hierarchy lost")
			}
			assertSpanLimits(t, spans[0])
		})
	}
}

func BenchmarkRequestTracing(b *testing.B) {
	for _, mode := range []string{"disabled", "unsampled", "sampled"} {
		b.Run(mode, func(b *testing.B) {
			tracer := New(nil)
			if mode != "disabled" {
				ratio := float64(0)
				if mode == "sampled" {
					ratio = 1
				}
				provider := newProvider(Config{SamplerRatio: ratio}, tracetest.NewNoopExporter())
				defer func() { _ = provider.Shutdown(context.Background()) }()
				tracer = New(provider)
			}
			b.ReportAllocs()
			for b.Loop() {
				_, end := tracer.Start(b.Context(), "service")
				end(nil)
			}
		})
	}
}

func assertSpanLimits(t *testing.T, childSpan tracetest.SpanStub) {
	t.Helper()
	if len(childSpan.Attributes) != maxSpanAttributes || len(childSpan.Events) != maxSpanEvents ||
		childSpan.DroppedAttributes != 5 || childSpan.DroppedEvents != maxSpanAttributes+5-maxSpanEvents {
		t.Fatalf("span limits not enforced: %v", childSpan)
	}
	for _, attr := range childSpan.Attributes {
		if len(attr.Value.AsString()) != maxAttributeLength {
			t.Fatal("unbounded value")
		}
	}
}

// gatedExporter keeps the first export in flight while a deterministic burst
// saturates the batch queue. It never stores application spans after exporting.
type gatedExporter struct {
	started   chan struct{}
	release   chan struct{}
	once      sync.Once
	exported  atomic.Int64
	oversized atomic.Bool
}

func (e *gatedExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	e.once.Do(func() { close(e.started) })
	select {
	case <-e.release:
		e.exported.Add(int64(len(spans)))
		if len(spans) > maxBatchSpans {
			e.oversized.Store(true)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *gatedExporter) Shutdown(context.Context) error { return nil }

func TestBatchQueueDropsExcessWithoutBlockingRequests(t *testing.T) {
	t.Parallel()
	exporter := &gatedExporter{started: make(chan struct{}), release: make(chan struct{})}
	provider := newProvider(Config{SamplerRatio: 1}, exporter)
	defer func() { _ = provider.Shutdown(context.Background()) }()
	// Release the gate even when an assertion fails before the normal release.
	var once sync.Once
	defer once.Do(func() { close(exporter.release) })
	tracer := provider.Tracer("test")
	for range maxBatchSpans {
		_, span := tracer.Start(t.Context(), "initial batch")
		span.End()
	}
	select {
	case <-exporter.started:
	case <-time.After(5 * time.Second):
		t.Fatal("batch never started exporting")
	}
	completed := make(chan struct{})
	go func() {
		for range maxQueuedSpans * 4 {
			_, span := tracer.Start(t.Context(), "request")
			span.End()
		}
		close(completed)
	}()
	select {
	case <-completed:
	case <-time.After(5 * time.Second):
		t.Fatal("span completion blocked on the saturated queue")
	}
	once.Do(func() { close(exporter.release) })
	if err := provider.ForceFlush(t.Context()); err != nil {
		t.Fatal(err)
	}
	if exporter.oversized.Load() || exporter.exported.Load() > maxQueuedSpans+maxBatchSpans ||
		exporter.exported.Load() < maxBatchSpans {
		t.Fatalf("queue or batch bounds violated: exported=%d", exporter.exported.Load())
	}
}
