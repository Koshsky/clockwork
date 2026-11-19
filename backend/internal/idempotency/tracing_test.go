package idempotency_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	idem "github.com/Koshsky/erp-backend/internal/idempotency"
	tracingmw "github.com/Koshsky/erp-backend/internal/middleware/tracing"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

func TestRequestRetriesHaveSeparateTracesWithoutRepeatingMutation(t *testing.T) {
	t.Parallel()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	tracer := tracingpkg.New(provider)
	repo := newFakeRepo()
	middleware := idem.New(repo, slog.New(slog.DiscardHandler), tracer)
	router := gin.New()
	router.Use(tracingmw.HTTPRootSpan(tracer), setUser(), middleware.Handler())
	executions := 0
	router.POST("/tasks", func(c *gin.Context) { executions++; c.JSON(http.StatusCreated, gin.H{"id": executions}) })
	for range 2 {
		req := httptest.NewRequest(http.MethodPost, "/tasks", nil)
		req.Header.Set(headerKey, "retry-fixture")
		req.Header.Set("Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != http.StatusCreated {
			t.Fatal("tracing changed the operation response")
		}
	}
	if executions != 1 || repo.completesCount() != 1 {
		t.Fatal("retry duplicated the business operation")
	}
	var roots []sdktrace.ReadOnlySpan
	for _, span := range recorder.Ended() {
		if span.Name() == "HTTP POST /tasks" {
			roots = append(roots, span)
		}
	}
	if len(roots) != 2 || roots[0].SpanContext().TraceID() == roots[1].SpanContext().TraceID() ||
		len(roots[0].Links()) != 1 || len(roots[1].Links()) != 1 ||
		roots[0].Links()[0].SpanContext.TraceID() != roots[1].Links()[0].SpanContext.TraceID() {
		t.Fatal("retry attempts shared a long-lived span or lost the correlation link")
	}
}
