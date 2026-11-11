package database

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// requestTxKey is the context key carrying the request-scoped transaction,
// opened by the idempotency middleware for requests with an Idempotency-Key.
type requestTxKey struct{}

// WithTx returns a context carrying tx. Repository layers resolve their query
// handle from the context (see TxFrom), so every database access of a request
// runs inside the same transaction when one is active.
func WithTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, requestTxKey{}, tx)
}

// TxFrom returns the request-scoped transaction carried by ctx, if any.
func TxFrom(ctx context.Context) (pgx.Tx, bool) {
	tx, ok := ctx.Value(requestTxKey{}).(pgx.Tx)
	return tx, ok
}
