package repository_test

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository/sqlc"
)

type transactionRow struct{ err error }

func (r transactionRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	values := []any{int64(3), int64(11), int64(21), int32(2), time.Time{}, time.Time{}}
	for i, value := range values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type requestTransaction struct {
	pgx.Tx

	context    context.Context
	calls      [][]any
	scanErrors []error
	execError  error
	finalized  bool
}

func (tx *requestTransaction) QueryRow(ctx context.Context, _ string, args ...any) pgx.Row {
	if ctx != tx.context {
		return transactionRow{err: errors.New("request context lost")}
	}
	tx.calls = append(tx.calls, args)
	var err error
	if len(tx.scanErrors) > 0 {
		err = tx.scanErrors[0]
		tx.scanErrors = tx.scanErrors[1:]
	}
	return transactionRow{err: err}
}
func (tx *requestTransaction) Exec(ctx context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	if ctx != tx.context {
		return pgconn.CommandTag{}, errors.New("request context lost")
	}
	tx.calls = append(tx.calls, args)
	return pgconn.NewCommandTag("DELETE 1"), tx.execError
}
func (tx *requestTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *requestTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func newRequestTransaction(t *testing.T, failures ...error) *requestTransaction {
	t.Helper()
	tx := &requestTransaction{scanErrors: failures}
	tx.context = database.WithTx(t.Context(), tx)
	return tx
}

func TestAssignmentRepositoryJoinsRequestTransaction(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		run  func(context.Context, *repository.AssignmentRepository) error
		args []any
	}{
		{"create", func(ctx context.Context, r *repository.AssignmentRepository) error {
			_, err := r.CreateAssignment(ctx, 11, 21, 4)
			return err
		}, []any{int64(11), int64(21), int64(4)}},
		{"find", func(ctx context.Context, r *repository.AssignmentRepository) error {
			_, err := r.FindAssignment(ctx, 3)
			return err
		}, []any{int64(3)}},
		{"find pair", func(ctx context.Context, r *repository.AssignmentRepository) error {
			_, err := r.FindAssignmentByKey(ctx, 11, 21)
			return err
		}, []any{int64(11), int64(21)}},
		{"update", func(ctx context.Context, r *repository.AssignmentRepository) error {
			_, err := r.UpdateAssignment(ctx, sqlc.Assignment{ID: 3, TaskID: 11, ResourceID: 21}, 4)
			return err
		}, []any{int64(11), int64(21), int64(4), int64(3)}},
		{"delete", func(ctx context.Context, r *repository.AssignmentRepository) error { return r.DeleteAssignment(ctx, 3) }, []any{int64(3)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("transaction query failed")} {
				tx := newRequestTransaction(t, failure)
				tx.execError = failure
				repo := repository.NewAssignmentRepository(slog.New(slog.DiscardHandler), nil)
				err := tc.run(tx.context, repo)
				if !errors.Is(err, failure) || len(tx.calls) != 1 || !reflect.DeepEqual(tx.calls[0], tc.args) ||
					tx.finalized {
					t.Fatalf("request transaction changed: calls=%v finalized=%v error=%v", tx.calls, tx.finalized, err)
				}
			}
		})
	}
}

func TestAssignmentDuplicateCreateReadsWithinRequestTransaction(t *testing.T) {
	t.Parallel()
	for _, failure := range []error{nil, errors.New("pair lookup failed")} {
		tx := newRequestTransaction(t, pgx.ErrNoRows, failure)
		repo := repository.NewAssignmentRepository(slog.New(slog.DiscardHandler), nil)
		row, err := repo.CreateAssignment(tx.context, 11, 21, 9)
		wantCalls := [][]any{{int64(11), int64(21), int64(9)}, {int64(11), int64(21)}}
		if !errors.Is(err, failure) || !reflect.DeepEqual(tx.calls, wantCalls) || tx.finalized {
			t.Fatalf("duplicate lookup escaped request transaction: %v, %v", tx.calls, err)
		}
		if failure == nil && (row == nil || row.ID != 3 || row.Quantity != 2) {
			t.Fatalf("duplicate request overwrote stored quantity: %+v", row)
		}
		if failure != nil && row != nil {
			t.Fatal("failed duplicate lookup returned a row")
		}
	}
}
