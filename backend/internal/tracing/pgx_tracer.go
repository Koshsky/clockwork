package tracing

import (
	"context"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// maxSQLLength caps how much SQL text is stored on a DB span to avoid bloating
// trace payloads with large statement bodies.
const maxSQLLength = 512

// QueryTracer implements pgx.QueryTracer so every Exec/Query/QueryRow across
// all repositories gets its own child span with SQL text and timing. Attached
// once to the pool, it covers every sqlc-generated query without per-repo
// changes.
type QueryTracer struct {
	tracer trace.Tracer
}

// NewQueryTracer builds a tracer over the given trace.Tracer.
func NewQueryTracer(t trace.Tracer) *QueryTracer {
	return &QueryTracer{tracer: t}
}

// TraceQueryStart begins a span for a single query.
//
//nolint:spancheck // span is ended via trace.SpanFromContext in TraceQueryEnd.
func (qt *QueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	op := queryOperation(data.SQL)
	ctx, _ = qt.tracer.Start(ctx, "DB "+op,
		trace.WithAttributes(
			attribute.String("db.system", "postgresql"),
			attribute.String("db.statement", shortSQL(data.SQL)),
		),
	)
	return ctx
}

// TraceQueryEnd finalizes the query span, marking errors and row counts.
func (qt *QueryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	span := trace.SpanFromContext(ctx)
	if data.Err != nil {
		span.RecordError(data.Err)
		span.SetStatus(codes.Error, data.Err.Error())
		span.SetAttributes(attribute.String(AttrErrorMessage, data.Err.Error()))
	}
	if rows := data.CommandTag.RowsAffected(); rows > 0 {
		span.SetAttributes(attribute.String("db.rows_affected", strconv.FormatInt(rows, 10)))
	}
	span.End()
}

// TraceBatchStart begins a span for a batch of queries; nested per-statement
// spans are created by TraceQueryStart.
//
//nolint:spancheck // span is ended via trace.SpanFromContext in TraceBatchEnd.
func (qt *QueryTracer) TraceBatchStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchStartData) context.Context {
	ctx, _ = qt.tracer.Start(ctx, "DB batch")
	return ctx
}

// TraceBatchQuery is a no-op: the batch-level span stays open until TraceBatchEnd.
func (qt *QueryTracer) TraceBatchQuery(_ context.Context, _ *pgx.Conn, _ pgx.TraceBatchQueryData) {}

// TraceBatchEnd finalizes the batch span.
func (qt *QueryTracer) TraceBatchEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceBatchEndData) {
	trace.SpanFromContext(ctx).End()
}

// queryOperation extracts a short span name from the leading SQL keyword.
func queryOperation(sql string) string {
	idx := strings.IndexByte(sql, ' ')
	if idx <= 0 {
		return sql
	}
	return strings.ToUpper(sql[:idx])
}

// shortSQL collapses newlines and truncates long statements.
func shortSQL(sql string) string {
	flat := strings.Join(strings.Fields(sql), " ")
	if len(flat) > maxSQLLength {
		return flat[:maxSQLLength] + "..."
	}
	return flat
}

var _ pgx.QueryTracer = (*QueryTracer)(nil)
var _ pgx.BatchTracer = (*QueryTracer)(nil)
