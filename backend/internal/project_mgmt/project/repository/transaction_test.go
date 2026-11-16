package repository_test

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type projectRow struct {
	values []any
	err    error
}

func (r projectRow) Scan(dest ...any) error {
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
	calls     [][]any
	row       projectRow
	finalized bool
}

func newRequestTransaction(t *testing.T, values []any, failure error) *requestTransaction {
	t.Helper()
	tx := &requestTransaction{row: projectRow{values: values, err: failure}}
	tx.context = database.WithTx(t.Context(), tx)
	return tx
}
func (tx *requestTransaction) QueryRow(ctx context.Context, _ string, args ...any) pgx.Row {
	if ctx != tx.context {
		return projectRow{err: errors.New("request context lost")}
	}
	tx.calls = append(tx.calls, args)
	return tx.row
}
func (tx *requestTransaction) Exec(ctx context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	if ctx != tx.context {
		return pgconn.CommandTag{}, errors.New("request context lost")
	}
	tx.calls = append(tx.calls, args)
	return pgconn.NewCommandTag("DELETE 1"), tx.row.err
}
func (tx *requestTransaction) Commit(context.Context) error   { tx.finalized = true; return nil }
func (tx *requestTransaction) Rollback(context.Context) error { tx.finalized = true; return nil }

func TestProjectRepositoryRequestTransaction(t *testing.T) {
	t.Parallel()
	owner := pgtype.Int8{Int64: 7, Valid: true}
	responsible := pgtype.Int8{Int64: 8, Valid: true}
	color := sql.NullString{String: "#123456", Valid: true}
	values := []any{
		int64(3),
		owner,
		"Project",
		color,
		date.Date("2026-01-01"),
		date.Date("2026-01-03"),
		int32(2),
		time.Time{},
		time.Time{},
		responsible,
	}
	for _, tc := range []struct {
		name         string
		run          func(context.Context, *repository.ProjectRepository) error
		args, values []any
	}{
		{"create", func(ctx context.Context, r *repository.ProjectRepository) error {
			_, err := r.CreateProject(ctx, new(int64(7)), new(int64(8)), "Project", new("#123456"), "2026-01-01", "2026-01-03", 2)
			return err
		}, []any{"Project", date.Date("2026-01-01"), date.Date("2026-01-03"), int64(2), owner, responsible, color}, values},
		{"find", func(ctx context.Context, r *repository.ProjectRepository) error {
			_, err := r.FindProject(ctx, 3)
			return err
		}, []any{int64(3)}, values},
		{"update", func(ctx context.Context, r *repository.ProjectRepository) error {
			_, err := r.UpdateProject(ctx, sqlc.Project{ID: 3, OwnerID: owner, ResponsibleID: responsible, Code: "Project", Color: color, StartDate: "2026-01-01", EndDate: "2026-01-03"}, 2)
			return err
		}, []any{"Project", color, int64(2), date.Date("2026-01-01"), date.Date("2026-01-03"), owner, responsible, int64(3)}, values},
		{"delete", func(ctx context.Context, r *repository.ProjectRepository) error { return r.DeleteProject(ctx, 3) }, []any{int64(3)}, nil},
		{"auto created feedback", func(ctx context.Context, r *repository.ProjectRepository) error {
			_, err := r.AutoCreatedCounts(ctx, 3)
			return err
		}, []any{int64(3)}, []any{int64(2), int64(4), int64(6)}},
		{"count down scope", func(ctx context.Context, r *repository.ProjectRepository) error {
			_, err := r.CountProjects(ctx, 7, access.ListScope{Down: true}, 9)
			return err
		}, []any{false, false, int64(7), false, true, false, int64(9)}, []any{int64(1)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, failure := range []error{nil, errors.New("transaction query failed")} {
				tx := newRequestTransaction(t, tc.values, failure)
				repo := repository.NewProjectRepository(slog.New(slog.DiscardHandler), nil)
				err := tc.run(tx.context, repo)
				if !errors.Is(err, failure) || len(tx.calls) != 1 || !reflect.DeepEqual(tx.calls[0], tc.args) ||
					tx.finalized {
					t.Fatalf("request transaction changed: calls=%v finalized=%v error=%v", tx.calls, tx.finalized, err)
				}
			}
		})
	}
}

func TestProjectDuplicateCodeReturnsConflict(t *testing.T) {
	t.Parallel()
	tx := newRequestTransaction(t, nil, pgx.ErrNoRows)
	repo := repository.NewProjectRepository(slog.New(slog.DiscardHandler), nil)
	row, err := repo.CreateProject(tx.context, new(int64(7)), nil, "Existing", nil, "2026-01-01", "2026-01-02", 0)
	if row != nil || !errors.Is(err, errorsapi.ErrConflict) || len(tx.calls) != 1 || tx.finalized {
		t.Fatalf("duplicate code semantics changed: %+v, %v", row, err)
	}
}
