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
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type taskRow struct{ err error }

func (r taskRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	values := []any{
		int64(3),
		int64(11),
		pgtype.Int8{},
		pgtype.Int8{Int64: 7, Valid: true},
		"Task",
		sql.NullString{},
		"not_started",
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
		return taskRow{err: errors.New("request context lost")}
	}
	tx.calls = append(tx.calls, queryCall{name: strings.SplitN(query, "\n", 2)[0], args: args})
	return taskRow{err: tx.rowError}
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

func TestTaskRepositoryJoinsRequestTransaction(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		run  func(context.Context, *repository.TaskRepository) error
		args []any
	}{
		{"FindTask", func(ctx context.Context, r *repository.TaskRepository) error {
			_, err := r.FindTask(ctx, 3)
			return err
		}, []any{int64(3)}},
		{"UpdateTask", func(ctx context.Context, r *repository.TaskRepository) error {
			_, err := r.UpdateTask(ctx, sqlc.Task{ID: 3, ProcessID: 11, OwnerID: pgtype.Int8{Int64: 9, Valid: true}, ResponsibleID: pgtype.Int8{Int64: 8, Valid: true}, Title: "Changed", Status: "done", StartDate: "2027-01-01", EndDate: "2027-01-03"})
			return err
		}, []any{pgtype.Int8{Int64: 9, Valid: true}, pgtype.Int8{Int64: 8, Valid: true}, "Changed", sql.NullString{}, "done", date.Date("2027-01-01"), date.Date("2027-01-03"), int64(3)}},
		{"DeleteTask", func(ctx context.Context, r *repository.TaskRepository) error { return r.DeleteTask(ctx, 3) }, []any{int64(3)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("transaction query failed")} {
				tx := newRequestTransaction(t)
				tx.rowError = failure
				tx.execErrors = []error{failure}
				err := tc.run(tx.context, repository.NewTaskRepository(slog.New(slog.DiscardHandler), nil))
				if !errors.Is(err, failure) || len(tx.calls) != 1 || !reflect.DeepEqual(tx.calls[0].args, tc.args) ||
					!strings.Contains(tx.calls[0].name, tc.name) ||
					tx.finalized {
					t.Fatalf("request transaction/arguments changed: %v, %v", tx.calls, err)
				}
			}
		})
	}
}

func TestTaskAppendLocksAndPreservesParentInRequestTransaction(t *testing.T) {
	t.Parallel()
	failure := errors.New("transaction query failed")
	for _, tc := range []struct {
		name                string
		parent              pgtype.Int8
		lockError, rowError error
		calls               int
	}{
		{"top level", pgtype.Int8{}, nil, nil, 2}, {"subtask", pgtype.Int8{Int64: 1, Valid: true}, nil, nil, 2},
		{"lock failure", pgtype.Int8{}, failure, nil, 1}, {"insert failure", pgtype.Int8{}, nil, failure, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tx := newRequestTransaction(t)
			tx.execErrors = []error{tc.lockError}
			tx.rowError = tc.rowError
			input := sqlc.Task{
				ProcessID:     11,
				ParentID:      tc.parent,
				OwnerID:       pgtype.Int8{Int64: 7, Valid: true},
				ResponsibleID: pgtype.Int8{Int64: 8, Valid: true},
				Title:         "Task",
				Status:        "not_started",
				StartDate:     "2026-01-01",
				EndDate:       "2026-01-03",
			}
			row, err := repository.NewTaskRepository(slog.New(slog.DiscardHandler), nil).CreateTask(tx.context, input)
			want := tc.lockError
			if want == nil {
				want = tc.rowError
			}
			if !errors.Is(err, want) || len(tx.calls) != tc.calls || tx.finalized ||
				!strings.Contains(tx.calls[0].name, "LockTaskAppendOrder") {
				t.Fatalf("append transaction/lock changed: %v, %v", tx.calls, err)
			}
			if tc.calls == 2 {
				checkTaskInsert(t, tx, input)
			}
			if want == nil && (row == nil || row.SortOrder != 4) {
				t.Fatalf("append lost database order: %+v", row)
			}
			if want != nil && row != nil {
				t.Fatal("failed append returned a task")
			}
		})
	}
}
func checkTaskInsert(t *testing.T, tx *requestTransaction, input sqlc.Task) {
	t.Helper()
	parent := int64(0)
	if input.ParentID.Valid {
		parent = input.ParentID.Int64
	}
	want := []any{
		int64(11),
		parent,
		input.OwnerID,
		input.ResponsibleID,
		"Task",
		sql.NullString{},
		"not_started",
		date.Date("2026-01-01"),
		date.Date("2026-01-03"),
	}
	if !strings.Contains(tx.calls[1].name, "CreateTask") || !reflect.DeepEqual(tx.calls[1].args, want) {
		t.Fatalf("append fields changed: %v", tx.calls)
	}
}

func TestTaskReorderTwoPhasesJoinRequestTransaction(t *testing.T) {
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
			err := repository.NewTaskRepository(slog.New(slog.DiscardHandler), nil).ReorderTasks(tx.context, ids)
			if !errors.Is(err, tc.want) || len(tx.calls) != tc.calls || tx.finalized {
				t.Fatalf("reorder transaction changed: %v, %v", tx.calls, err)
			}
			names := []string{"ReorderTasksMark", "ReorderTasksApply"}
			for i, call := range tx.calls {
				if !strings.Contains(call.name, names[i]) || !reflect.DeepEqual(call.args, []any{ids}) {
					t.Fatalf("reorder phases changed: %v", tx.calls)
				}
			}
		})
	}
}
