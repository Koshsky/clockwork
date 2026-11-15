package repository_test

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type dependencyRow struct {
	values []any
	err    error
}

func (r dependencyRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, value := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type requestTransaction struct {
	pgx.Tx

	context   context.Context
	name      string
	args      []any
	calls     int
	row       dependencyRow
	finalized bool
}

func newRequestTransaction(t *testing.T, values []any, failure error) *requestTransaction {
	t.Helper()
	tx := &requestTransaction{row: dependencyRow{values: values, err: failure}}
	tx.context = database.WithTx(t.Context(), tx)
	return tx
}
func (tx *requestTransaction) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if ctx != tx.context {
		return dependencyRow{err: errors.New("request context lost")}
	}
	tx.calls++
	tx.name, tx.args = query, args
	return tx.row
}
func (tx *requestTransaction) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	if ctx != tx.context {
		return pgconn.CommandTag{}, errors.New("request context lost")
	}
	tx.calls++
	tx.name, tx.args = query, args
	return pgconn.NewCommandTag("DELETE 1"), tx.row.err
}
func (tx *requestTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *requestTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func TestDependencyRepositoryUsesRequestTransaction(t *testing.T) {
	t.Parallel()
	values := []any{int64(3), int64(1), int64(2), "fs", time.Time{}, time.Time{}}
	for _, tc := range []struct {
		name         string
		run          func(context.Context, *repository.TaskDependencyRepository) error
		args, values []any
	}{
		{"CreateDependency", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.CreateDependency(ctx, 1, 2, "fs")
			return err
		}, []any{int64(1), int64(2), "fs"}, values},
		{"FindDependency", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.FindDependency(ctx, 3)
			return err
		}, []any{int64(3)}, values},
		{"UpdateDependencyType", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.UpdateDependencyType(ctx, 3, "ss")
			return err
		}, []any{"ss", int64(3)}, values},
		{"DeleteDependency", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			return r.DeleteDependency(ctx, 3)
		}, []any{int64(3)}, nil},
		{"DependencyExists", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.DependencyExists(ctx, 1, 2)
			return err
		}, []any{int64(1), int64(2)}, []any{false}},
		{"DependencyCycle", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.DependencyCycle(ctx, 1, 2)
			return err
		}, []any{int64(1), int64(2)}, []any{false}},
		{"FindTaskDates", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.FindTaskDates(ctx, 1)
			return err
		}, []any{int64(1)}, []any{date.Date("2026-02-10"), date.Date("2026-02-20")}},
		{"ValidateLink", func(ctx context.Context, r *repository.TaskDependencyRepository) error {
			_, err := r.ValidateLink(ctx, 1, 2)
			return err
		}, []any{int64(2), int64(1)}, []any{int64(1), "Successor", date.Date("2026-02-10"), date.Date("2026-02-20"), int64(11), true, int64(2), "Predecessor", date.Date("2026-02-01"), date.Date("2026-02-10"), int64(11), true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("transaction query failed")} {
				tx := newRequestTransaction(t, tc.values, failure)
				err := tc.run(tx.context, repository.NewTaskDependencyRepository(slog.New(slog.DiscardHandler), nil))
				if !errors.Is(err, failure) || tx.calls != 1 || !reflect.DeepEqual(tx.args, tc.args) ||
					!strings.Contains(tx.name, tc.name) ||
					tx.finalized {
					t.Fatalf(
						"query escaped request transaction: calls=%d args=%v finalized=%v error=%v",
						tx.calls,
						tx.args,
						tx.finalized,
						err,
					)
				}
			}
		})
	}
}
