package tracing_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/Koshsky/erp-backend/internal/logger"
	tracingmw "github.com/Koshsky/erp-backend/internal/middleware/tracing"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

func TestHTTPRootSpanResult(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		status    int
		cancelled bool
		wantError bool
	}{
		{name: "success", status: http.StatusOK},
		{name: "client denial", status: http.StatusForbidden},
		{name: "server failure", status: http.StatusInternalServerError, wantError: true},
		{name: "cancelled request", status: http.StatusRequestTimeout, cancelled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tracer, recorder := recordingTracer(t)
			router := gin.New()
			router.Use(tracingmw.HTTPRootSpan(tracer))
			router.GET("/task", func(c *gin.Context) {
				c.Set(tracingpkg.RequestIDKey, "req-42")
				if tc.cancelled && !errors.Is(c.Request.Context().Err(), context.Canceled) {
					t.Fatal("adapter replaced the cancelled request context")
				}
				c.Status(tc.status)
			})
			parent := trace.NewSpanContext(trace.SpanContextConfig{
				TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}, TraceFlags: trace.FlagsSampled,
			})
			ctx, cancel := context.WithCancel(trace.ContextWithSpanContext(t.Context(), parent))
			defer cancel()
			if tc.cancelled {
				cancel()
			}
			request := httptest.NewRequestWithContext(ctx, http.MethodGet, "/task?offset=2", nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			spans := recorder.Ended()
			if len(spans) != 1 || response.Code != tc.status {
				t.Fatalf("spans=%d, response=%d", len(spans), response.Code)
			}
			assertHTTPResult(t, spans[0], parent, tc.status, tc.wantError)
		})
	}
}

func assertHTTPResult(t *testing.T, span sdktrace.ReadOnlySpan, parent trace.SpanContext, status int, wantError bool) {
	t.Helper()
	if span.Name() != "HTTP GET /task" || !span.Parent().Equal(parent) {
		t.Fatalf("root name/parent changed: %q, %v", span.Name(), span.Parent())
	}
	attrs := spanAttributes(span)
	if attrs[tracingpkg.AttrHTTPMethod].AsString() != http.MethodGet ||
		attrs[tracingpkg.AttrHTTPPath].AsString() != "/task?offset=2" ||
		attrs[tracingpkg.AttrHTTPStatusCode].AsInt64() != int64(status) ||
		attrs[tracingpkg.AttrRequestID].AsString() != "req-42" {
		t.Fatalf("HTTP attributes changed: %v", attrs)
	}
	wantStatus := codes.Unset
	wantDescription := ""
	if wantError {
		wantStatus = codes.Error
		wantDescription = "http server error"
	}
	if span.Status().Code != wantStatus || span.Status().Description != wantDescription {
		t.Fatalf("unexpected root status: %v", span.Status())
	}
}

func TestGinSpanRetainsRootActorAndLogCorrelation(t *testing.T) {
	t.Parallel()
	tracer, recorder := recordingTracer(t)
	var buffer bytes.Buffer
	log := slog.New(logger.NewContextHandler(slog.NewJSONHandler(&buffer, nil)))
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(tracingpkg.RequestIDKey, "request-actor")
		c.Request = c.Request.WithContext(tracingpkg.WithRequestID(c.Request.Context(), "request-actor"))
		c.Next()
	})
	router.Use(tracingmw.HTTPRootSpan(tracer), tracingmw.GinSpan(tracer, "middleware.auth"))
	router.GET("/task", func(c *gin.Context) {
		ctx, end := tracer.Start(c.Request.Context(), "task.Find")
		defer end(nil)
		root, found := tracingmw.FromGin(c)
		if !found || root.SpanContext().Equal(trace.SpanContextFromContext(ctx)) {
			t.Fatal("root lookup returned the active child instead of the request root")
		}
		tracingmw.SetUserOnSpan(c, 42, "vp")
		log.InfoContext(ctx, "task found")
		c.Status(http.StatusNoContent)
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/task", nil))
	spans := recorder.Ended()
	if response.Code != http.StatusNoContent || len(spans) != 3 {
		t.Fatalf("response=%d, completed spans=%d", response.Code, len(spans))
	}
	service, middleware, root := spans[0], spans[1], spans[2]
	if service.Name() != "task.Find" || middleware.Name() != "middleware.auth" || root.Name() != "HTTP GET /task" ||
		!service.Parent().Equal(middleware.SpanContext()) || !middleware.Parent().Equal(root.SpanContext()) {
		t.Fatal("middleware/service span hierarchy changed")
	}
	attrs := spanAttributes(root)
	if attrs[tracingpkg.AttrUserID].AsInt64() != 42 || attrs[tracingpkg.AttrUserRole].AsString() != "vp" {
		t.Fatalf("authenticated actor missing from root: %v", attrs)
	}
	if _, ok := spanAttributes(service)[tracingpkg.AttrUserID]; ok {
		t.Fatal("actor was attached to service span instead of root")
	}
	var entry map[string]any
	if err := json.Unmarshal(buffer.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["trace_id"] != root.SpanContext().TraceID().String() ||
		entry["span_id"] != service.SpanContext().SpanID().String() || entry["request_id"] != "request-actor" {
		t.Fatalf("log correlation changed: %v", entry)
	}
}

func TestMissingRootDoesNotEnrichUnrelatedSpan(t *testing.T) {
	t.Parallel()
	for _, invalid := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "wrong type"}[invalid], func(t *testing.T) {
			t.Parallel()
			tracer, recorder := recordingTracer(t)
			ctx, end := tracer.Start(t.Context(), "unrelated")
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequestWithContext(ctx, http.MethodGet, "/task", nil)
			if invalid {
				c.Set("tracing.root_span", "not a span")
			}
			if span, found := tracingmw.FromGin(c); span != nil || found {
				t.Fatalf("invalid root accepted: %v, %v", span, found)
			}
			tracingmw.SetUserOnSpan(c, 42, "vp")
			end(nil)
			if spans := recorder.Ended(); len(spans) != 1 || len(spans[0].Attributes()) != 0 {
				t.Fatalf("unrelated span was enriched: %v", spans)
			}
		})
	}
}

func recordingTracer(t *testing.T) (*tracingpkg.Tracer, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	return tracingpkg.New(provider), recorder
}

func spanAttributes(span sdktrace.ReadOnlySpan) map[attribute.Key]attribute.Value {
	attributes := make(map[attribute.Key]attribute.Value)
	for _, attr := range span.Attributes() {
		attributes[attr.Key] = attr.Value
	}
	return attributes
}
