//nolint:testpackage // use the configured queue/batch limits in real OTLP receiver tests.
package tracing

import (
	"context"
	"crypto/tls"
	"encoding/pem"
	"errors"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	release "github.com/Koshsky/erp-backend"
	"github.com/Koshsky/erp-backend/internal/config"
)

type exportRequest struct {
	body       *collector.ExportTraceServiceRequest
	auth       []string
	unexpected []string
}

type traceReceiver struct {
	collector.UnimplementedTraceServiceServer

	requests    chan exportRequest
	failFirst   atomic.Bool
	block       bool
	connections atomic.Int32
}

func (r *traceReceiver) Export(
	ctx context.Context,
	request *collector.ExportTraceServiceRequest,
) (*collector.ExportTraceServiceResponse, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	r.requests <- exportRequest{body: request, auth: md.Get("authorization"), unexpected: md.Get("canary")}
	if r.block {
		<-ctx.Done()
		return nil, status.Error(codes.DeadlineExceeded, "canary-receiver-details")
	}
	if r.failFirst.CompareAndSwap(true, false) {
		return nil, status.Error(codes.Unavailable, "canary-receiver-details")
	}
	return &collector.ExportTraceServiceResponse{}, nil
}

type countedListener struct {
	net.Listener

	connections *atomic.Int32
}

func (l *countedListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err == nil {
		l.connections.Add(1)
	}
	return conn, err
}

func startTraceReceiver(t *testing.T, secure bool, receiver *traceReceiver) Config {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Enabled:          true,
		ExporterEndpoint: listener.Addr().String(),
		SamplerRatio:     1,
		ServiceVersion:   "1.6.0",
		Insecure:         !secure,
	}
	var options []grpc.ServerOption
	if secure {
		fixture := httptest.NewTLSServer(nil)
		cert := fixture.TLS.Certificates[0]
		fixture.Close()
		options = append(
			options,
			grpc.Creds(
				credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}),
			),
		)
		cfg.CAFile = filepath.Join(t.TempDir(), "ca.pem")
		if err = os.WriteFile(
			cfg.CAFile,
			pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
	}
	server := grpc.NewServer(options...)
	collector.RegisterTraceServiceServer(server, receiver)
	done := make(chan error, 1)
	go func() { done <- server.Serve(&countedListener{Listener: listener, connections: &receiver.connections}) }()
	t.Cleanup(func() {
		server.Stop()
		if serveErr := <-done; serveErr != nil && !errors.Is(serveErr, grpc.ErrServerStopped) {
			t.Error(serveErr)
		}
	})
	return cfg
}

func preserveOTelHandler(t *testing.T) {
	t.Helper()
	old := otel.GetErrorHandler()
	t.Cleanup(func() { otel.SetErrorHandler(old) })
}

func TestOTLPExportsTLSAuthAndFlushesOnShutdown(t *testing.T) {
	preserveOTelHandler(t)
	receiver := &traceReceiver{requests: make(chan exportRequest, 8)}
	cfg := startTraceReceiver(t, true, receiver)
	cfg.AuthToken = "fixture-token"
	// Ambient settings must not redirect the connection, add headers, disable TLS
	// verification, alter the sampler or remove the fixed span limits.
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://invalid.example:9")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_INSECURE", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "canary=canary-secret")
	t.Setenv("OTEL_TRACES_SAMPLER", "always_off")
	t.Setenv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "99999")
	tracer, err := NewTracer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, end := tracer.Start(t.Context(), "service")
	_, childEnd := tracer.Start(ctx, "DB SELECT")
	childEnd(nil)
	end(nil)
	if err = tracer.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-receiver.requests:
		if len(request.auth) != 1 || request.auth[0] != "Bearer fixture-token" || len(request.unexpected) != 0 {
			t.Fatal("explicit exporter authentication was not isolated")
		}
		resource := request.body.GetResourceSpans()[0]
		spans := resource.GetScopeSpans()[0].GetSpans()
		if len(spans) != 2 || string(spans[0].GetParentSpanId()) != string(spans[1].GetSpanId()) {
			t.Fatal("flush lost child/parent spans")
		}
		attrs := resource.GetResource().GetAttributes()
		if len(attrs) != 2 || attrs[1].GetValue().GetStringValue() != "1.6.0" {
			t.Fatalf("missing release identity: %v", attrs)
		}
	default:
		t.Fatal("shutdown did not flush pending spans")
	}
}

//nolint:paralleltest // Setup owns the process-wide OTel error handler.
func TestOTLPRejectsUntrustedCertificate(t *testing.T) {
	preserveOTelHandler(t)
	receiver := &traceReceiver{requests: make(chan exportRequest, 8)}
	cfg := startTraceReceiver(t, true, receiver)
	cfg.CAFile = ""
	provider, shutdown, err := Setup(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = shutdown(t.Context()) }()
	_, span := provider.Tracer("test").Start(t.Context(), "test")
	span.End()
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	if err = provider.ForceFlush(ctx); err == nil {
		t.Fatal("untrusted TLS receiver accepted")
	}
	if len(receiver.requests) != 0 {
		t.Fatal("sent spans through an untrusted connection")
	}
}

func TestDisabledTracingDoesNotContactReceiver(t *testing.T) {
	t.Parallel()
	receiver := &traceReceiver{requests: make(chan exportRequest, 8)}
	cfg := startTraceReceiver(t, false, receiver)
	cfg.Enabled = false
	cfg.CAFile = "/missing/canary.pem"
	cfg.AuthToken = "canary\n-token"
	tracer, err := NewTracer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for range 10 {
		_, end := tracer.Start(t.Context(), "disabled")
		end(nil)
	}
	if err = tracer.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(receiver.requests) != 0 || receiver.connections.Load() != 0 {
		t.Fatal("disabled tracing opened an export connection")
	}
}

//nolint:paralleltest // Setup owns the process-wide OTel error handler.
func TestUnavailableExporterDoesNotBlockOperationsAndShutdown(t *testing.T) {
	preserveOTelHandler(t)
	receiver := &traceReceiver{requests: make(chan exportRequest, 64), block: true}
	cfg := startTraceReceiver(t, false, receiver)
	started := time.Now()
	provider, shutdown, err := Setup(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Freeze an export until cancellation while a burst exceeds the queue capacity.
	tracer := provider.Tracer("test")
	_, span := tracer.Start(t.Context(), "first")
	span.End()
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	flushed := make(chan error, 1)
	go func() { flushed <- provider.ForceFlush(ctx) }()
	select {
	case <-receiver.requests:
	case <-ctx.Done():
		t.Fatal("receiver never saw the blocked export")
	}
	for range maxQueuedSpans * 4 {
		_, item := tracer.Start(t.Context(), "business operation")
		item.End()
	}
	if time.Since(started) > time.Second {
		t.Fatal("export queue blocked the business path")
	}
	if err = <-flushed; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("flush deadline lost: %v", err)
	}
	shutdownCtx, stop := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer stop()
	if err = shutdown(shutdownCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown deadline lost: %v", err)
	}
}

//nolint:paralleltest // Setup owns the process-wide OTel error handler.
func TestOTLPExportRetryReusesCompletedSpan(t *testing.T) {
	preserveOTelHandler(t)
	receiver := &traceReceiver{requests: make(chan exportRequest, 8)}
	receiver.failFirst.Store(true)
	cfg := startTraceReceiver(t, false, receiver)
	tracer, err := NewTracer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, end := tracer.Start(t.Context(), "completed mutation")
	end(nil)
	if err = tracer.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	first, second := receiveTrace(t, receiver), receiveTrace(t, receiver)
	a, b := first.body.GetResourceSpans()[0].GetScopeSpans()[0].GetSpans()[0], second.body.GetResourceSpans()[0].GetScopeSpans()[0].GetSpans()[0]
	if string(a.GetTraceId()) != string(b.GetTraceId()) || string(a.GetSpanId()) != string(b.GetSpanId()) ||
		a.GetEndTimeUnixNano() != b.GetEndTimeUnixNano() {
		t.Fatal("export retry recreated/reopened a completed operation span")
	}
	if strings.Contains(first.body.String(), "canary") {
		t.Fatal("export included receiver diagnostics")
	}
}

func receiveTrace(t *testing.T, receiver *traceReceiver) exportRequest {
	t.Helper()
	select {
	case request := <-receiver.requests:
		return request
	case <-time.After(5 * time.Second):
		t.Fatal("missing OTLP request")
		return exportRequest{}
	}
}

//nolint:paralleltest // Setup owns the process-wide SDK error handler.
func TestProvideTracerUsesCanonicalReleaseVersion(t *testing.T) {
	preserveOTelHandler(t)
	for _, version := range []string{"dev", "2.0.0"} {
		t.Run(version, func(t *testing.T) {
			receiver := &traceReceiver{requests: make(chan exportRequest, 8)}
			cfg := startTraceReceiver(t, false, receiver)
			tracer, err := ProvideTracer(
				config.TracingConfig{
					Enabled:          true,
					ExporterEndpoint: cfg.ExporterEndpoint,
					Insecure:         true,
					SamplerRatio:     1,
				},
				version,
				nil,
			)
			if err != nil {
				t.Fatal(err)
			}
			_, end := tracer.Start(t.Context(), "version")
			end(nil)
			if err = tracer.Shutdown(t.Context()); err != nil {
				t.Fatal(err)
			}
			attrs := receiveTrace(t, receiver).body.GetResourceSpans()[0].GetResource().GetAttributes()
			if len(attrs) != 2 || attrs[1].GetValue().GetStringValue() != release.NewInfo(version).Version {
				t.Fatal("Wire provider lost canonical/injected version")
			}
		})
	}
}

//nolint:paralleltest // Setup owns the process-wide SDK error handler.
func TestAbsentReceiverDoesNotDelayStartupOrFailBusinessWork(t *testing.T) {
	preserveOTelHandler(t)
	// A real reachable TCP listener without a gRPC server simulates a completely
	// unavailable protocol endpoint without relying on a fixed unused system port.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	started := time.Now()
	tracer, err := NewTracer(
		Config{Enabled: true, ExporterEndpoint: listener.Addr().String(), Insecure: true, SamplerRatio: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, end := tracer.Start(t.Context(), "business operation")
	end(nil)
	if time.Since(started) > time.Second {
		t.Fatal("startup or business operation waited for a trace receiver")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if err = tracer.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unavailable receiver shutdown: %v", err)
	}
}
