//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository/sqlc"
)

// StoredResult is a saved response of a completed idempotency key.
type StoredResult struct {
	Status int
	Body   json.RawMessage
}

// claimLease — how long an in-flight key is considered "alive"; longer means a crash.
const claimLease = 2 * time.Minute

// claimRetryAttempts — how many times we repeat observing/re-claiming the key.
const claimRetryAttempts = 2

// IdempotencyRepository stores/retrieves idempotency keys and their responses.
type IdempotencyRepository struct {
	pool *pgxpool.Pool
	db   *sqlc.Queries
}

// NewIdempotencyRepository builds the IdempotencyRepository repository.
func NewIdempotencyRepository(pool *pgxpool.Pool) *IdempotencyRepository {
	return &IdempotencyRepository{pool: pool, db: sqlc.New(pool)}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (opened by the idempotency middleware), otherwise the shared pool.
func (r *IdempotencyRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

// Claim atomically claims the key for this (user, method, path).
//
// Returns:
//   - claimed=true with a non-nil tx when this call acquired the key: the
//     caller (middleware) must run the operation inside tx, then Complete/Release
//     and Commit/Rollback the transaction.
//   - claimed=false with a non-nil result when the key was already completed by a
//     previous call (the caller must replay result without re-executing).
//   - claimed=false with a nil result when the key exists but the request is
//     still in flight (the caller should return a conflict, not re-execute).
//
// The claim row itself is committed immediately (pool-bound): concurrent
// retries observe it as in-flight and get a conflict instead of waiting on an
// open transaction. Stale keys are re-claimed: a completed key past its TTL or
// an in-flight key older than the lease (a crashed request) is deleted and
// claimed again, so a retry is not blocked by a dead claim.
func (r *IdempotencyRepository) Claim(
	ctx context.Context,
	key string,
	userID int64,
	method, path string,
	expiresAt time.Time,
) (*StoredResult, bool, pgx.Tx, error) {
	params := sqlc.CreateIdempotencyKeyParams{
		Key:       key,
		UserID:    userID,
		Method:    method,
		Path:      path,
		ExpiresAt: expiresAt,
	}
	_, err := r.db.CreateIdempotencyKey(ctx, params)
	if err == nil {
		// We claimed the key: open the request transaction. The middleware
		// drives it — business writes and Complete commit atomically.
		return r.beginRequestTx(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil, err
	}
	// The key already exists — check whether the first call completed; a stale
	// (expired or stuck) key is re-claimed. A stale key lost in a re-claim race
	// is observed again on the next iteration.
	for attempt := range claimRetryAttempts {
		result, claimed, oerr := r.claimExisting(ctx, params)
		if oerr != nil {
			return nil, false, nil, oerr
		}
		if claimed {
			return r.beginRequestTx(ctx)
		}
		if result != nil {
			return result, false, nil, nil
		}
		// In flight or lost a race: return 409 on the last iteration.
		if attempt == claimRetryAttempts-1 {
			return nil, false, nil, nil
		}
	}
	return nil, false, nil, nil
}

// beginRequestTx opens the transaction the middleware drives for a claimed key.
// A failed begin leaves the committed claim row in-flight; the lease logic in
// claimExisting reclaims it later, so a retry is not blocked forever.
func (r *IdempotencyRepository) beginRequestTx(ctx context.Context) (*StoredResult, bool, pgx.Tx, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, false, nil, err
	}
	return nil, true, tx, nil
}

// claimExisting observes the current state of an existing key. A stale key
// (expired or in-flight longer than the lease — a crash) is deleted and re-claimed.
// Returns: a ready replay result (result, claimed=false),
// a claim indicator (claimed=true), or "in flight" (nil, false, nil).
func (r *IdempotencyRepository) claimExisting(
	ctx context.Context,
	params sqlc.CreateIdempotencyKeyParams,
) (*StoredResult, bool, error) {
	existing, err := r.db.GetIdempotencyKey(ctx, sqlc.GetIdempotencyKeyParams{
		Key:    params.Key,
		UserID: params.UserID,
		Method: params.Method,
		Path:   params.Path,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The key disappeared between checks — treat it as a conflict without replay.
			return nil, false, nil
		}
		return nil, false, err
	}
	if reclaimable(existing, time.Now(), claimLease) {
		if derr := r.db.DeleteIdempotencyKey(ctx, sqlc.DeleteIdempotencyKeyParams{
			Key:    params.Key,
			UserID: params.UserID,
			Method: params.Method,
			Path:   params.Path,
		}); derr != nil {
			return nil, false, derr
		}
		// Re-claim (one of the retries wins the race).
		_, ierr := r.db.CreateIdempotencyKey(ctx, params)
		if ierr == nil {
			return nil, true, nil
		}
		if !errors.Is(ierr, pgx.ErrNoRows) {
			return nil, false, ierr
		}
		return nil, false, nil
	}
	if existing.ResponseStatus <= 0 {
		// The first request is still running.
		return nil, false, nil
	}
	return &StoredResult{Status: int(existing.ResponseStatus), Body: existing.ResponseBody}, false, nil
}

// reclaimable reports whether an existing key row should be deleted and
// re-claimed: completed but expired (cleanup has not run yet), or in-flight
// for longer than the lease (the claiming request crashed).
func reclaimable(existing sqlc.IdempotencyKey, now time.Time, lease time.Duration) bool {
	if existing.ExpiresAt.Before(now) {
		return true
	}
	return existing.ResponseStatus <= 0 && existing.CreatedAt.Before(now.Add(-lease))
}

// Complete saves the response of the completed call under the key. It runs
// inside the request-scoped transaction (resolved from ctx), so the completion
// commits atomically with the request's business writes.
func (r *IdempotencyRepository) Complete(
	ctx context.Context,
	key string,
	userID int64,
	method, path string,
	status int,
	body json.RawMessage,
) error {
	// HTTP statuses are always small and fit into int32; a safeguard against
	// range overflow (gosec G115) — we never store an incorrect status in the DB.
	if status <= 0 || status > math.MaxInt32 {
		status = http.StatusInternalServerError
	}
	return r.q(ctx).CompleteIdempotencyKey(ctx, sqlc.CompleteIdempotencyKeyParams{
		Key:            key,
		UserID:         userID,
		Method:         method,
		Path:           path,
		ResponseStatus: int32(status),
		ResponseBody:   body,
	})
}

// Release deletes the key (e.g. on 5xx so a retry can run the operation again).
// Pool-bound on purpose: the delete must survive the rolled-back request
// transaction, so it never joins the ambient tx.
func (r *IdempotencyRepository) Release(
	ctx context.Context,
	key string,
	userID int64,
	method, path string,
) error {
	return r.db.DeleteIdempotencyKey(ctx, sqlc.DeleteIdempotencyKeyParams{
		Key:    key,
		UserID: userID,
		Method: method,
		Path:   path,
	})
}

// DeleteExpired deletes keys whose TTL has expired. Pool-bound: independent of
// any request transaction.
func (r *IdempotencyRepository) DeleteExpired(ctx context.Context) error {
	return r.db.DeleteExpiredIdempotencyKeys(ctx)
}
