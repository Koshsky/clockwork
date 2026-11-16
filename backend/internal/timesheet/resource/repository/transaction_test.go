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

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type resourceRow struct {
	values []any
	err    error
}

func (r resourceRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, value := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type emptyRows struct {
	pgx.Rows

	err error
}

func (r *emptyRows) Next() bool { return false }
func (r *emptyRows) Close()     {}
func (r *emptyRows) Err() error { return r.err }

type queryCall struct {
	name string
	args []any
}
type requestTransaction struct {
	pgx.Tx

	context   context.Context
	calls     []queryCall
	rows      []resourceRow
	failure   error
	finalized bool
}

func newRequestTransaction(t *testing.T, rows ...resourceRow) *requestTransaction {
	t.Helper()
	tx := &requestTransaction{rows: rows}
	tx.context = database.WithTx(t.Context(), tx)
	return tx
}
func (tx *requestTransaction) record(ctx context.Context, query string, args []any) error {
	if ctx != tx.context {
		return errors.New("request context lost")
	}
	tx.calls = append(tx.calls, queryCall{name: strings.SplitN(query, "\n", 2)[0], args: args})
	return nil
}
func (tx *requestTransaction) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if err := tx.record(ctx, query, args); err != nil {
		return resourceRow{err: err}
	}
	if len(tx.rows) == 0 {
		return resourceRow{err: errors.New("unexpected row query")}
	}
	row := tx.rows[0]
	tx.rows = tx.rows[1:]
	return row
}
func (tx *requestTransaction) Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error) {
	if err := tx.record(ctx, query, args); err != nil {
		return pgconn.CommandTag{}, err
	}
	return pgconn.NewCommandTag("DELETE 1"), tx.failure
}
func (tx *requestTransaction) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if err := tx.record(ctx, query, args); err != nil {
		return nil, err
	}
	return &emptyRows{err: tx.failure}, nil
}
func (tx *requestTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *requestTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func TestResourceWritesCountMembersInRequestTransaction(t *testing.T) {
	t.Parallel()
	for _, operation := range []string{"create", "update"} {
		for _, step := range []string{"success", "mutation fails", "count fails"} {
			t.Run(operation+"/"+step, func(t *testing.T) {
				t.Parallel()
				checkResourceWriteTransaction(t, operation, step)
			})
		}
	}
}
func checkResourceWriteTransaction(t *testing.T, operation, step string) {
	t.Helper()
	failure := errors.New("transaction query failed")
	stored := resourceRow{
		values: []any{int64(3), "Resource", "R", sql.NullString{}, int64(9), time.Time{}, time.Time{}},
	}
	count := resourceRow{values: []any{int64(4)}}
	if step == "mutation fails" {
		stored.err = failure
	}
	if step == "count fails" {
		count.err = failure
	}
	tx := newRequestTransaction(t, stored, count)
	repo := repository.NewResourceRepository(slog.New(slog.DiscardHandler), nil)
	var row *sqlc.ListResourcesRow
	var err error
	args := []any{"Resource", "R", sql.NullString{}, int64(9)}
	name := "CreateResource"
	if operation == "create" {
		row, err = repo.CreateResource(tx.context, "R", "Resource", nil, new(int64(9)))
	} else {
		row, err = repo.UpdateResource(tx.context, 3, "R", "Resource", nil, new(int64(9)))
		args = append(args, int64(3))
		name = "UpdateResource"
	}
	want := failure
	if step == "success" {
		want = nil
	}
	if !errors.Is(err, want) || tx.finalized || !strings.Contains(tx.calls[0].name, name) ||
		!reflect.DeepEqual(tx.calls[0].args, args) {
		t.Fatalf("resource write escaped transaction: %v, %v", tx.calls, err)
	}
	checkResourceCountQuery(t, tx, step)
	if want == nil && (row == nil || row.EmployeesCount != 4 || row.OwnerID != 9 || row.Title != "Resource") {
		t.Fatalf("member count/resource fields changed: %+v", row)
	}
	if want != nil && row != nil {
		t.Fatal("failed write/count returned a resource")
	}
}
func checkResourceCountQuery(t *testing.T, tx *requestTransaction, step string) {
	t.Helper()
	calls := 2
	if step == "mutation fails" {
		calls = 1
	}
	if len(tx.calls) != calls {
		t.Fatalf("member count query sequence changed: %v", tx.calls)
	}
	if calls == 2 &&
		(!strings.Contains(tx.calls[1].name, "CountMembersByResourceID") || !reflect.DeepEqual(tx.calls[1].args, []any{int64(3)})) {
		t.Fatalf("member count did not share transaction/resource: %v", tx.calls)
	}
}

func TestResourceQueriesUseAmbientTransaction(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name         string
		run          func(context.Context, *repository.ResourceRepository) error
		args, values []any
	}{
		{"FindResource", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.FindResource(ctx, 3)
			return err
		}, []any{int64(3)}, []any{int64(3), "R", "Resource", sql.NullString{}, int64(7), int64(4), time.Time{}, time.Time{}}},
		{"DeleteResource", func(ctx context.Context, r *repository.ResourceRepository) error { return r.DeleteResource(ctx, 3) }, []any{int64(3)}, nil},
		{"AddMember", func(ctx context.Context, r *repository.ResourceRepository) error { return r.AddMember(ctx, 3, 8) }, []any{int64(3), int64(8)}, nil},
		{"RemoveMember", func(ctx context.Context, r *repository.ResourceRepository) error { return r.RemoveMember(ctx, 3, 8) }, []any{int64(3), int64(8)}, nil},
		{"FindUserManager", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.FindUserManager(ctx, 8)
			return err
		}, []any{int64(8)}, []any{pgtype.Int8{Int64: 7, Valid: true}}},
		{"ListMembersByResourceID", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.ListMembersByResourceID(ctx, 3)
			return err
		}, []any{int64(3)}, nil},
		{"ListResourceAbsence", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.ListAbsence(ctx, 3, "2026-12-31", "2027-01-02")
			return err
		}, []any{int64(3), date.Date("2026-12-31"), date.Date("2027-01-02")}, nil},
		{"ListResources", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.ListResources(ctx, 7, access.ListScope{Self: true}, 0, 20, 40)
			return err
		}, []any{false, false, int64(7), true, false, int64(0), int64(40), int64(20)}, nil},
		{"OwnerChain", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.OwnerChain(ctx, 3)
			return err
		}, []any{int64(3)}, []any{int64(7)}},
		{"ListResourcesByOwnerID", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.ListResourcesByOwnerID(ctx, 7)
			return err
		}, []any{int64(7)}, nil},
		{"CountResources", func(ctx context.Context, r *repository.ResourceRepository) error {
			_, err := r.CountResources(ctx, 7, access.ListScope{Self: true}, 0)
			return err
		}, []any{false, false, int64(7), true, false, int64(0)}, []any{int64(1)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("transaction query failed")} {
				tx := newRequestTransaction(t, resourceRow{values: tc.values, err: failure})
				tx.failure = failure
				err := tc.run(tx.context, repository.NewResourceRepository(slog.New(slog.DiscardHandler), nil))
				if !errors.Is(err, failure) || len(tx.calls) != 1 || tx.finalized ||
					!strings.Contains(tx.calls[0].name, tc.name) ||
					!reflect.DeepEqual(tx.calls[0].args, tc.args) {
					t.Fatalf("ambient transaction/arguments changed: %v, %v", tx.calls, err)
				}
			}
		})
	}
}

func TestResourceDuplicateCodeRemainsConflict(t *testing.T) {
	t.Parallel()
	tx := newRequestTransaction(t, resourceRow{err: pgx.ErrNoRows})
	row, err := repository.NewResourceRepository(slog.New(slog.DiscardHandler), nil).
		CreateResource(tx.context, "R", "Resource", nil, new(int64(7)))
	if !errors.Is(err, errorsapi.ErrConflict) || row != nil || len(tx.calls) != 1 || tx.finalized {
		t.Fatalf("duplicate code/count semantics changed: %+v, %v", row, err)
	}
}
