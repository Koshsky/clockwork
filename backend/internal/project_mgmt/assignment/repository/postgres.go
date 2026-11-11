//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository/sqlc"
)

type AssignmentRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewAssignmentRepository builds the AssignmentRepository repository.
func NewAssignmentRepository(logger *slog.Logger, pool *pgxpool.Pool) *AssignmentRepository {
	return &AssignmentRepository{
		logger: logger.With("component", "assignment_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *AssignmentRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *AssignmentRepository) CreateAssignment(
	ctx context.Context,
	taskID, resourceID int64,
	quantity int,
) (*sqlc.Assignment, error) {
	row, err := r.q(ctx).CreateAssignment(ctx, sqlc.CreateAssignmentParams{
		TaskID:     taskID,
		ResourceID: resourceID,
		Quantity:   int64(quantity),
	})
	if err != nil {
		// Idempotent create: for an already-active (task_id, resource_id) pair,
		// INSERT ... ON CONFLICT DO NOTHING inserts no row and RETURNING comes
		// back empty. Return the already existing record.
		if errors.Is(err, pgx.ErrNoRows) {
			return r.FindAssignmentByKey(ctx, taskID, resourceID)
		}
		return nil, err
	}

	return &row, nil
}

// FindAssignmentByKey returns the assignment for the active (task_id, resource_id) pair.
func (r *AssignmentRepository) FindAssignmentByKey(
	ctx context.Context,
	taskID, resourceID int64,
) (*sqlc.Assignment, error) {
	row, err := r.q(ctx).FindAssignmentByKey(ctx, sqlc.FindAssignmentByKeyParams{
		TaskID:     taskID,
		ResourceID: resourceID,
	})
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *AssignmentRepository) FindAssignment(ctx context.Context, id int64) (*sqlc.Assignment, error) {
	row, err := r.q(ctx).FindAssignment(ctx, id)
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *AssignmentRepository) UpdateAssignment(
	ctx context.Context,
	assignment sqlc.Assignment,
	quantity int,
) (*sqlc.Assignment, error) {
	row, err := r.q(ctx).UpdateAssignment(ctx, sqlc.UpdateAssignmentParams{
		AssignmentID: assignment.ID,
		TaskID:       assignment.TaskID,
		ResourceID:   assignment.ResourceID,
		Quantity:     int64(quantity),
	})
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *AssignmentRepository) DeleteAssignment(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteAssignment(ctx, id)
}

func (r *AssignmentRepository) ListAssignments(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]sqlc.Assignment, error) {
	return r.q(ctx).ListAssigments(ctx, sqlc.ListAssigmentsParams{
		ScAll:          scope.All,
		UserID:         userID,
		ScParent:       scope.Parent,
		ScAncestor:     scope.Ancestor,
		ScNone:         scope.None,
		OwnerID:        ownerID,
		PageLimit:      int64(limit),
		PageOffset:     int64(offset),
		ScProjectOwner: scope.ProjectOwner,
		ScProcessOwner: scope.ProcessOwner,
		ProjectView:    scope.ProjectView,
		ProcessView:    scope.ProcessView,
		TaskView:       scope.TaskView,
	})
}

func (r *AssignmentRepository) CountAssignments(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
) (int64, error) {
	return r.q(ctx).CountAssignments(
		ctx,
		sqlc.CountAssignmentsParams{
			UserID:         userID,
			ScAll:          scope.All,
			ScParent:       scope.Parent,
			ScAncestor:     scope.Ancestor,
			ScNone:         scope.None,
			OwnerID:        ownerID,
			ScProjectOwner: scope.ProjectOwner,
			ScProcessOwner: scope.ProcessOwner,
			ProjectView:    scope.ProjectView,
			ProcessView:    scope.ProcessView,
			TaskView:       scope.TaskView,
		},
	)
}

// OwnerChain returns the owner chain (for RBAC checks in the middleware).
func (r *AssignmentRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	row, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{
		ProjectOwner: row.ProjectOwner, ProcessOwner: row.ProcessOwner,
		Owner: row.OwnerID, ResourceOwner: row.ResourceOwner,
	}, nil
}
