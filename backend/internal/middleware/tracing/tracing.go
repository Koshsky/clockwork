// Package tracing adapts the shared tracer to Gin requests.
package tracing

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

// ginSpanKey keeps actor enrichment on the root while child spans are active.
const ginSpanKey = "tracing.root_span"

// FromGin returns the request's root span, if one was attached.
func FromGin(c *gin.Context) (trace.Span, bool) {
	v, ok := c.Get(ginSpanKey)
	if !ok {
		return nil, false
	}
	span, ok := v.(trace.Span)
	return span, ok
}

// HTTPRootSpan records the completed HTTP result without coupling the core to Gin.
func HTTPRootSpan(t *tracingpkg.Tracer) gin.HandlerFunc {
	return func(c *gin.Context) {
		method := diagnostics.HTTPMethod(c.Request.Method)
		ctx, span := t.Unwrap().Start(c.Request.Context(), "HTTP "+method)
		c.Request = c.Request.WithContext(ctx)
		c.Set(ginSpanKey, span)

		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		span.SetName("HTTP " + method + " " + route)
		status := c.Writer.Status()
		span.SetAttributes(
			attribute.String(tracingpkg.AttrHTTPMethod, method),
			attribute.String(tracingpkg.AttrHTTPPath, route),
			attribute.Int(tracingpkg.AttrHTTPStatusCode, status),
			attribute.String(tracingpkg.AttrRequestID, c.GetString(tracingpkg.RequestIDKey)),
		)
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, "http server error")
		}
		span.End()
	}
}

// GinSpan preserves named middleware spans inside the request trace.
func GinSpan(t *tracingpkg.Tracer, name string) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, end := t.Start(c.Request.Context(), name)
		c.Request = c.Request.WithContext(ctx)
		defer end(nil)
		c.Next()
	}
}

// SetUserOnSpan enriches the root even when authentication runs inside a child span.
func SetUserOnSpan(c *gin.Context, _ int64, _ string) {
	span, ok := FromGin(c)
	if !ok {
		return
	}
	span.SetAttributes(
		attribute.Bool("user.authenticated", true),
	)
}
