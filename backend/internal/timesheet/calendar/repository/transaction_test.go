package repository_test

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type calendarRows struct {
	pgx.Rows

	err error
}

func (r *calendarRows) Next() bool { return false }
func (r *calendarRows) Close()     {}
func (r *calendarRows) Err() error { return r.err }

type calendarTransaction struct {
	pgx.Tx

	context   context.Context
	query     string
	args      []any
	calls     int
	failure   error
	finalized bool
}

func newCalendarTransaction(t *testing.T, failure error) *calendarTransaction {
	t.Helper()
	tx := &calendarTransaction{failure: failure}
	tx.context = database.WithTx(t.Context(), tx)
	return tx
}
func (tx *calendarTransaction) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if ctx != tx.context {
		return nil, errors.New("request context lost")
	}
	tx.calls++
	tx.query, tx.args = query, args
	return &calendarRows{err: tx.failure}, nil
}
func (tx *calendarTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *calendarTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func TestCalendarQueriesUseRequestTransactionAndScopeArguments(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		run  func(context.Context, *repository.CalendarRepository) error
		args []any
	}{
		{"ListResources/own", func(ctx context.Context, r *repository.CalendarRepository) error {
			_, err := r.ListResources(ctx, 7, access.ListScope{Self: true})
			return err
		}, []any{false, false, int64(7), true, false}},
		{"ListResources/all", func(ctx context.Context, r *repository.CalendarRepository) error {
			_, err := r.ListResources(ctx, 7, access.ListScope{All: true})
			return err
		}, []any{true, false, int64(7), false, false}},
		{"ListResources/project resources", func(ctx context.Context, r *repository.CalendarRepository) error {
			_, err := r.ListResources(ctx, 7, access.ListScope{ProjectResources: true})
			return err
		}, []any{false, true, int64(7), false, false}},
		{"ListEmployeesForCalendar", func(ctx context.Context, r *repository.CalendarRepository) error {
			_, err := r.ListEmployeesForCalendar(ctx, "2026-12-31", "2027-01-02")
			return err
		}, []any{date.Date("2027-01-02"), date.Date("2026-12-31")}},
		{"ListUnavailableRanges", func(ctx context.Context, r *repository.CalendarRepository) error {
			_, err := r.ListUnavailableRanges(ctx, "2026-12-31", "2027-01-02")
			return err
		}, []any{date.Date("2026-12-31"), date.Date("2027-01-02")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("calendar transaction query failed")} {
				tx := newCalendarTransaction(t, failure)
				err := tc.run(tx.context, repository.NewCalendarRepository(slog.New(slog.DiscardHandler), nil))
				method, _, _ := strings.Cut(tc.name, "/")
				if !errors.Is(err, failure) || tx.calls != 1 || tx.finalized || !strings.Contains(tx.query, method) ||
					!reflect.DeepEqual(tx.args, tc.args) {
					t.Fatalf("calendar transaction/scope/window changed: %s %v, %v", tx.query, tx.args, err)
				}
			}
		})
	}
}
