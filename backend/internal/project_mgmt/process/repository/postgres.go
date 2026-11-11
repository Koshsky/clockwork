//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/pkg/date"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type ProcessRepository struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	db     *sqlc.Queries
}

// NewProcessRepository builds the ProcessRepository repository.
func NewProcessRepository(logger *slog.Logger, pool *pgxpool.Pool) *ProcessRepository {
	return &ProcessRepository{
		logger: logger.With("component", "process_repository"),
		pool:   pool,
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *ProcessRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *ProcessRepository) CreateProcess(
	ctx context.Context,
	projectID int64,
	title string,
	color *string,
	ownerID *int64,
	responsibleID *int64,
	startDate, endDate date.Date,
) (*sqlc.Process, error) {
	row, err := r.q(ctx).CreateProcess(ctx, sqlc.CreateProcessParams{
		ProjectID:     projectID,
		Title:         title,
		Color:         nullable.ToString(color),
		StartDate:     startDate,
		EndDate:       endDate,
		OwnerID:       nullable.ToInt8(ownerID),
		ResponsibleID: nullable.ToInt8(responsibleID),
	})
	if err != nil {
		return nil, errapi.MapPgConstraint(errapi.FromPgInvalidParam(err))
	}

	return &row, nil
}

func (r *ProcessRepository) FindProcess(ctx context.Context, id int64) (*sqlc.Process, error) {
	row, err := r.q(ctx).FindProcess(ctx, id)
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *ProcessRepository) UpdateProcess(ctx context.Context, process sqlc.Process) (*sqlc.Process, error) {
	row, err := r.q(ctx).UpdateProcess(ctx, sqlc.UpdateProcessParams{
		ProcessID:     process.ID,
		OwnerID:       process.OwnerID,
		ResponsibleID: process.ResponsibleID,
		ProjectID:     process.ProjectID,
		Title:         process.Title,
		Color:         process.Color,
		StartDate:     process.StartDate,
		EndDate:       process.EndDate,
	})
	if err != nil {
		return nil, errapi.MapPgConstraint(errapi.FromPgInvalidParam(err))
	}

	return &row, nil
}

func (r *ProcessRepository) DeleteProcess(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteProcess(ctx, id)
}

func (r *ProcessRepository) ListProcesss(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]sqlc.Process, error) {
	return r.q(ctx).ListProcesss(ctx, sqlc.ListProcesssParams{
		ScAll:          scope.All,
		ScSelf:         scope.Self,
		UserID:         userID,
		ScParent:       scope.Parent,
		ScAncestor:     scope.Ancestor,
		ScSib:          scope.Sib,
		ScDown:         scope.Down,
		ScNone:         scope.None,
		OwnerID:        ownerID,
		PageLimit:      int64(limit),
		PageOffset:     int64(offset),
		ScProjectOwner: scope.ProjectOwner,
		ScProcessOwner: scope.ProcessOwner,
		ProjectView:    scope.ProjectView,
	})
}

func (r *ProcessRepository) CountProcesses(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
) (int64, error) {
	return r.q(ctx).CountProcesses(
		ctx,
		sqlc.CountProcessesParams{
			UserID:         userID,
			ScAll:          scope.All,
			ScSelf:         scope.Self,
			ScParent:       scope.Parent,
			ScAncestor:     scope.Ancestor,
			ScSib:          scope.Sib,
			ScDown:         scope.Down,
			ScNone:         scope.None,
			OwnerID:        ownerID,
			ScProjectOwner: scope.ProjectOwner,
			ScProcessOwner: scope.ProcessOwner,
			ProjectView:    scope.ProjectView,
		},
	)
}

// ListProcessIDsByProject returns the active process ids of a project in their
// display order — to validate a reorder request covers the whole group.
func (r *ProcessRepository) ListProcessIDsByProject(ctx context.Context, projectID int64) ([]int64, error) {
	return r.q(ctx).ListProcessIdsByProject(ctx, projectID)
}

// ReorderProcesses rewrites the sort_order of the given process ids by list
// position (1-based) in one transaction. The caller validates that the ids
// cover the whole group. The two-phase UPDATE parks the rows on offset slots
// first, because a single-statement value swap would transiently violate the
// partial unique index (project_id, sort_order).
func (r *ProcessRepository) ReorderProcesses(ctx context.Context, ids []int64) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = r.db.WithTx(tx)
	}
	if err = q.ReorderProcessesMark(ctx, ids); err != nil {
		return err
	}
	if err = q.ReorderProcessesApply(ctx, ids); err != nil {
		return err
	}
	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// OwnerChain returns the owner chain (for RBAC checks in the middleware).
func (r *ProcessRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	row, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{ProjectOwner: row.ProjectOwner, ProcessOwner: row.ProcessOwner}, nil
}
