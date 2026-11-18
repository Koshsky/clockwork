package tracing_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
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
		attrs[tracingpkg.AttrHTTPPath].AsString() != "/task" ||
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
	if !attrs["user.authenticated"].AsBool() || attrs[tracingpkg.AttrUserID].Type() != attribute.INVALID ||
		attrs[tracingpkg.AttrUserRole].Type() != attribute.INVALID {
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

func TestHTTPSpansRejectUnmatchedPathsQueriesAndMethods(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ method, target, route string }{
		{"GET", "/task/canary-object?password=canary-query", "/task/:id"},
		{"GET", "/canary-unmatched?token=canary-token", "unmatched"},
		{"canary-method", "/canary-unmatched", "unmatched"},
	} {
		t.Run(tc.method+tc.target, func(t *testing.T) {
			t.Parallel()
			tracer, recorder := recordingTracer(t)
			router := gin.New()
			router.Use(tracingmw.HTTPRootSpan(tracer))
			router.GET("/task/:id", func(c *gin.Context) { c.Status(http.StatusForbidden) })
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(tc.method, tc.target, nil))
			spans := recorder.Ended()
			if len(spans) != 1 {
				t.Fatalf("expected one HTTP outcome, got %d", len(spans))
			}
			if strings.Contains(fmt.Sprint(spans[0].Name(), spans[0].Attributes()), "canary-") ||
				spanAttributes(spans[0])[tracingpkg.AttrHTTPPath].AsString() != tc.route {
				t.Fatalf("request content leaked: %v", spans[0].Attributes())
			}
		})
	}
}

func TestPublicTraceContextLinksWithoutTrustingSamplingOrBaggage(t *testing.T) {
	t.Parallel()
	const parent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	for _, tc := range []struct {
		name    string
		parents []string
		linked  bool
	}{
		{name: "valid sampled", parents: []string{parent}, linked: true},
		{name: "valid unsampled", parents: []string{strings.TrimSuffix(parent, "01") + "00"}, linked: true},
		{name: "missing"},
		{name: "malformed", parents: []string{"canary-token"}},
		{name: "zero trace", parents: []string{"00-00000000000000000000000000000000-00f067aa0ba902b7-01"}},
		{name: "duplicate", parents: []string{parent, parent}},
		{name: "oversized", parents: []string{strings.Repeat("a", 513)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tracer, recorder := recordingTracer(t)
			router := gin.New()
			router.Use(tracingmw.HTTPRootSpan(tracer))
			router.GET("/task", func(c *gin.Context) {
				_, end := tracer.Start(c.Request.Context(), "service")
				end(nil)
				c.Status(http.StatusOK)
			})
			request := httptest.NewRequest(http.MethodGet, "/task", nil)
			for _, value := range tc.parents {
				request.Header.Add("Traceparent", value)
			}
			request.Header.Set("Tracestate", "vendor=canary-token")
			request.Header.Set("Baggage", "user.email=canary-email")
			router.ServeHTTP(httptest.NewRecorder(), request)
			spans := recorder.Ended()
			if len(spans) != 2 {
				t.Fatalf("missing request/service spans: %d", len(spans))
			}
			child, root := spans[0], spans[1]
			if root.Parent().IsValid() || child.Parent().SpanID() != root.SpanContext().SpanID() ||
				root.SpanKind() != trace.SpanKindServer {
				t.Fatal("untrusted parent replaced the server-owned root or internal hierarchy")
			}
			assertPublicLink(t, root, tc.linked)
			if strings.Contains(fmt.Sprint(root.Attributes(), root.Links(), child.Attributes()), "canary") {
				t.Fatal("untrusted metadata escaped")
			}
		})
	}
}

func assertPublicLink(t *testing.T, root sdktrace.ReadOnlySpan, linked bool) {
	t.Helper()
	if linked {
		links := root.Links()
		if len(links) != 1 || links[0].SpanContext.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" ||
			links[0].SpanContext.IsSampled() || links[0].SpanContext.TraceState().Len() != 0 ||
			root.SpanContext().TraceID() == links[0].SpanContext.TraceID() {
			t.Fatal("unsafe or missing W3C correlation link")
		}
	} else if len(root.Links()) != 0 {
		t.Fatal("malformed traceparent was accepted")
	}
}
