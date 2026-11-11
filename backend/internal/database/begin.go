package database

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BeginOrJoin starts a new transaction on pool, or returns the request-scoped
// transaction already carried by ctx (owned=false) so the caller joins it
// instead of opening a nested one. A caller that receives owned=true owns the
// transaction and must Commit/Rollback it; a caller with owned=false must leave
// commit/rollback to the transaction owner (the idempotency middleware).
func BeginOrJoin(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, bool, error) {
	if tx, ok := TxFrom(ctx); ok {
		return tx, false, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	return tx, true, nil
}
