package repository_test

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type processRow struct{ err error }

func (r processRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	values := []any{
		int64(3),
		int64(11),
		pgtype.Int8{Int64: 7, Valid: true},
		"Process",
		sql.NullString{},
		date.Date("2026-01-01"),
		date.Date("2026-01-03"),
		int32(4),
		time.Time{},
		time.Time{},
		pgtype.Int8{Int64: 8, Valid: true},
	}
	for i, value := range values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type queryCall struct {
	name string
	args []any
}
type requestTransaction struct {
	pgx.Tx

	context    context.Context
	calls      []queryCall
	execErrors []error
	rowError   error
	finalized  bool
}

func newRequestTransaction(t *testing.T) *requestTransaction {
	t.Helper()
	tx := &requestTransaction{}
	tx.context = database.WithTx(t.Context(), tx)
	return tx
}
func (tx *requestTransaction) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if ctx != tx.context {
		return processRow{err: errors.New("request context lost")}
	}
	tx.calls = append(tx.calls, queryCall{name: strings.SplitN(query, "\n", 2)[0], args: args})
	return processRow{err: tx.rowError}
}
func (tx *requestTransaction) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	if ctx != tx.context {
		return pgconn.CommandTag{}, errors.New("request context lost")
	}
	tx.calls = append(tx.calls, queryCall{name: strings.SplitN(query, "\n", 2)[0], args: args})
	var err error
	if len(tx.execErrors) > 0 {
		err = tx.execErrors[0]
		tx.execErrors = tx.execErrors[1:]
	}
	return pgconn.NewCommandTag("UPDATE 1"), err
}
func (tx *requestTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *requestTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func TestProcessRepositoryJoinsRequestTransaction(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		run  func(context.Context, *repository.ProcessRepository) error
		args []any
	}{
		{"FindProcess", func(ctx context.Context, r *repository.ProcessRepository) error {
			_, err := r.FindProcess(ctx, 3)
			return err
		}, []any{int64(3)}},
		{"UpdateProcess", func(ctx context.Context, r *repository.ProcessRepository) error {
			_, err := r.UpdateProcess(ctx, sqlc.Process{ID: 3, ProjectID: 12, OwnerID: pgtype.Int8{Int64: 9, Valid: true}, ResponsibleID: pgtype.Int8{Int64: 8, Valid: true}, Title: "Changed", StartDate: "2027-01-01", EndDate: "2027-01-03"})
			return err
		}, []any{"Changed", sql.NullString{}, date.Date("2027-01-01"), date.Date("2027-01-03"), int64(12), pgtype.Int8{Int64: 9, Valid: true}, pgtype.Int8{Int64: 8, Valid: true}, int64(3)}},
		{"DeleteProcess", func(ctx context.Context, r *repository.ProcessRepository) error { return r.DeleteProcess(ctx, 3) }, []any{int64(3)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("transaction query failed")} {
				tx := newRequestTransaction(t)
				tx.rowError = failure
				tx.execErrors = []error{failure}
				repo := repository.NewProcessRepository(slog.New(slog.DiscardHandler), nil)
				err := tc.run(tx.context, repo)
				if !errors.Is(err, failure) || len(tx.calls) != 1 || !reflect.DeepEqual(tx.calls[0].args, tc.args) ||
					!strings.Contains(tx.calls[0].name, tc.name) ||
					tx.finalized {
					t.Fatalf("request transaction changed: calls=%v finalized=%v error=%v", tx.calls, tx.finalized, err)
				}
			}
		})
	}
}

func TestProcessCreateLocksBeforeAppendInsideRequestTransaction(t *testing.T) {
	t.Parallel()
	failure := errors.New("transaction query failed")
	for _, tc := range []struct {
		name                string
		lockError, rowError error
		calls               int
	}{{"success", nil, nil, 2}, {"lock failure", failure, nil, 1}, {"insert failure", nil, failure, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tx := newRequestTransaction(t)
			tx.execErrors = []error{tc.lockError}
			tx.rowError = tc.rowError
			repo := repository.NewProcessRepository(slog.New(slog.DiscardHandler), nil)
			row, err := repo.CreateProcess(
				tx.context,
				11,
				"Process",
				nil,
				new(int64(7)),
				new(int64(8)),
				"2026-01-01",
				"2026-01-03",
			)
			want := tc.lockError
			if want == nil {
				want = tc.rowError
			}
			if !errors.Is(err, want) || len(tx.calls) != tc.calls || tx.finalized ||
				!strings.Contains(tx.calls[0].name, "LockProcessAppendOrder") {
				t.Fatalf("append lock/transaction changed: %v, %v", tx.calls, err)
			}
			if tc.calls == 2 {
				checkAppendInsert(t, tx)
			}
			if want == nil && (row == nil || row.SortOrder != 4) {
				t.Fatalf("append lost database order: %+v", row)
			}
			if want != nil && row != nil {
				t.Fatal("failed append returned a row")
			}
		})
	}
}

func TestProcessReorderTwoPhasesJoinRequestTransaction(t *testing.T) {
	t.Parallel()
	failure := errors.New("transaction query failed")
	for _, tc := range []struct {
		name     string
		failures []error
		want     error
		calls    int
	}{{"success", nil, nil, 2}, {"mark failure", []error{failure}, failure, 1}, {"apply failure", []error{nil, failure}, failure, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tx := newRequestTransaction(t)
			tx.execErrors = tc.failures
			ids := []int64{2, 1}
			err := repository.NewProcessRepository(slog.New(slog.DiscardHandler), nil).ReorderProcesses(tx.context, ids)
			if !errors.Is(err, tc.want) || len(tx.calls) != tc.calls || tx.finalized {
				t.Fatalf("reorder transaction changed: %v, %v", tx.calls, err)
			}
			names := []string{"ReorderProcessesMark", "ReorderProcessesApply"}
			for i, call := range tx.calls {
				if !strings.Contains(call.name, names[i]) || !reflect.DeepEqual(call.args, []any{ids}) {
					t.Fatalf("reorder phases/order changed: %v", tx.calls)
				}
			}
		})
	}
}

func checkAppendInsert(t *testing.T, tx *requestTransaction) {
	t.Helper()
	args := []any{
		int64(11),
		"Process",
		date.Date("2026-01-01"),
		date.Date("2026-01-03"),
		pgtype.Int8{Int64: 7, Valid: true},
		pgtype.Int8{Int64: 8, Valid: true},
		sql.NullString{},
	}
	if !strings.Contains(tx.calls[1].name, "CreateProcess") || !reflect.DeepEqual(tx.calls[1].args, args) {
		t.Fatalf("append fields changed: %v", tx.calls)
	}
}
