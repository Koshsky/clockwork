package repository

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/database"
	internalerrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository/sqlc"
)

// ClaimOperation holds a transaction lock until the business write and receipt commit together.
// Hash collisions only cause a retryable busy result; receipt identity never uses the hash.
func (r *IdempotencyRepository) ClaimOperation(
	ctx context.Context, userID int64, operationID string,
) (*sqlc.OperationReceipt, bool, pgx.Tx, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, false, nil, fmt.Errorf("begin operation: %w", err)
	}
	q := sqlc.New(tx)
	locked, err := q.TryOperationLock(ctx, strconv.FormatInt(userID, 10)+":"+operationID)
	if err != nil || !locked {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, false, nil, err
	}
	receipt, err := q.FindOperationReceipt(ctx, sqlc.FindOperationReceiptParams{
		UserID: userID, OperationID: operationID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, true, tx, nil
	}
	_ = tx.Rollback(context.WithoutCancel(ctx))
	if err != nil {
		return nil, false, nil, fmt.Errorf("find operation receipt: %w", err)
	}
	return &receipt, false, nil, nil
}

// InspectOperation distinguishes a committed result, an active sender and a safe-to-retry absence.
func (r *IdempotencyRepository) InspectOperation(
	ctx context.Context, userID int64, operationID string,
) (*sqlc.OperationReceipt, bool, error) {
	receipt, claimed, tx, err := r.ClaimOperation(ctx, userID, operationID)
	if tx != nil {
		if rollbackErr := tx.Rollback(context.WithoutCancel(ctx)); rollbackErr != nil {
			return nil, false, fmt.Errorf("release operation inspection: %w", rollbackErr)
		}
	}
	return receipt, !claimed && receipt == nil && err == nil, err
}

// CompleteOperation cannot be detached from the transaction holding the operation lock.
func (r *IdempotencyRepository) CompleteOperation(ctx context.Context, params sqlc.CompleteOperationParams) error {
	if _, ok := database.TxFrom(ctx); !ok {
		return internalerrors.ErrOperationTransactionRequired
	}
	if params.ResponseStatus < http.StatusOK || params.ResponseStatus >= http.StatusMultipleChoices {
		return internalerrors.ErrOperationResponseInvalid
	}
	if err := r.q(ctx).CompleteOperation(ctx, params); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	return nil
}
