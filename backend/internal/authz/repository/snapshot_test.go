package repository_test

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/authz/repository"
	"github.com/Koshsky/erp-backend/internal/database"
)

type snapshotRows struct {
	pgx.Rows

	values  [][]any
	index   int
	scanErr error
	rowErr  error
}

func (r *snapshotRows) Next() bool { r.index++; return r.index <= len(r.values) }
func (r *snapshotRows) Close()     {}
func (r *snapshotRows) Err() error { return r.rowErr }
func (r *snapshotRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	for i, value := range r.values[r.index-1] {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type snapshotTransaction struct {
	pgx.Tx

	ctx       context.Context
	rows      *snapshotRows
	queryErr  error
	method    string
	calls     int
	finalized bool
}

func (tx *snapshotTransaction) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	if ctx != tx.ctx || !strings.Contains(query, tx.method) || len(args) != 0 {
		return nil, errors.New("snapshot query/context changed")
	}
	tx.calls++
	return tx.rows, tx.queryErr
}

func (tx *snapshotTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *snapshotTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func checkSnapshotQuery(
	t *testing.T,
	method string,
	values [][]any,
	read func(context.Context, *repository.RuleRepository) ([][]any, error),
) {
	t.Helper()
	for _, mode := range []string{"rows", "empty", "query error", "scan error", "row error"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			failure := errors.New("snapshot read failed")
			tx := &snapshotTransaction{rows: &snapshotRows{values: values}, method: method}
			tx.ctx = database.WithTx(t.Context(), tx)
			want := values
			switch mode {
			case "empty":
				tx.rows.values, want = nil, [][]any{}
			case "query error":
				tx.queryErr = failure
			case "scan error":
				tx.rows.scanErr = failure
			case "row error":
				tx.rows.rowErr = failure
			}
			got, err := read(tx.ctx, repository.NewRuleRepository(slog.New(slog.DiscardHandler), nil))
			if strings.Contains(mode, "error") {
				if !errors.Is(err, failure) || got != nil {
					t.Fatalf("snapshot error/partial rows changed: %+v %v", got, err)
				}
			} else if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("snapshot fields/order/empty changed: %+v %v", got, err)
			}
			if tx.calls != 1 || tx.finalized {
				t.Fatal("snapshot query escaped or finalized caller transaction")
			}
		})
	}
}

func TestPrincipalSnapshotRowsPreserveNullablePresets(t *testing.T) {
	t.Parallel()
	checkSnapshotQuery(t, "ListUserPrincipals", [][]any{
		{int64(1), sql.NullString{}},
		{int64(2), sql.NullString{Valid: true}},
		{int64(3), sql.NullString{String: "worker", Valid: true}},
		{int64(4), sql.NullString{String: "Пресет", Valid: true}},
	}, func(ctx context.Context, repo *repository.RuleRepository) ([][]any, error) {
		rows, err := repo.ListUserPrincipals(ctx)
		if err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("empty principal snapshot became nil")
		}
		out := make([][]any, 0, len(rows))
		for _, row := range rows {
			out = append(out, []any{row.UserID, row.Preset})
		}
		return out, nil
	})
}

func TestPermissionSnapshotRowsPreserveGrantAndRevoke(t *testing.T) {
	t.Parallel()
	checkSnapshotQuery(t, "ListAllUserPermissions", [][]any{
		{int64(3), "project", "view", "all", true},
		{int64(3), "task", "update", "parent", false},
		{int64(4), "resource", "create", "self", true},
	}, func(ctx context.Context, repo *repository.RuleRepository) ([][]any, error) {
		rows, err := repo.ListAllUserPermissions(ctx)
		if err != nil {
			return nil, err
		}
		if rows == nil {
			return nil, errors.New("empty permission snapshot became nil")
		}
		out := make([][]any, 0, len(rows))
		for _, row := range rows {
			out = append(out, []any{row.UserID, row.Resource, row.Action, row.Scope, row.Granted})
		}
		return out, nil
	})
}
