package database

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/metrics"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
)

type poolTracer struct {
	*tracingpkg.QueryTracer

	metrics *metrics.Metrics
}

func newPoolTracer(tracer *tracingpkg.Tracer, observer *metrics.Metrics) pgx.QueryTracer {
	if tracer == nil && !observer.Enabled() {
		return nil
	}
	if tracer == nil {
		tracer = tracingpkg.New(nil)
	}
	queries := tracingpkg.NewQueryTracer(tracer.Unwrap())
	if !observer.Enabled() {
		return queries
	}
	return &poolTracer{QueryTracer: queries, metrics: observer}
}

func (p *poolTracer) TraceAcquireStart(
	ctx context.Context,
	_ *pgxpool.Pool,
	_ pgxpool.TraceAcquireStartData,
) context.Context {
	return ctx
}

func (p *poolTracer) TraceAcquireEnd(ctx context.Context, _ *pgxpool.Pool, data pgxpool.TraceAcquireEndData) {
	p.metrics.PoolAcquire(ctx, data.Err)
}

var _ pgxpool.AcquireTracer = (*poolTracer)(nil)
var _ pgx.BatchTracer = (*poolTracer)(nil)
