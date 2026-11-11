//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package postgres

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type MilestoneRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewMilestoneRepository builds the MilestoneRepository repository.
func NewMilestoneRepository(logger *slog.Logger, pool *pgxpool.Pool) *MilestoneRepository {
	return &MilestoneRepository{
		logger: logger.With("component", "milestone_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *MilestoneRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *MilestoneRepository) CreateMilestone(
	ctx context.Context,
	processID int64,
	title, content string,
	color *string,
	date date.Date,
) (*sqlc.Milestone, error) {
	row, err := r.q(ctx).CreateMilestone(ctx, sqlc.CreateMilestoneParams{
		ProcessID: processID,
		Title:     title,
		Content:   content,
		Color:     nullable.ToString(color),
		Date:      date,
	})
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *MilestoneRepository) FindMilestone(ctx context.Context, id int64) (*sqlc.Milestone, error) {
	row, err := r.q(ctx).FindMilestone(ctx, id)
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *MilestoneRepository) UpdateMilestone(
	ctx context.Context,
	milestone sqlc.Milestone,
) (*sqlc.Milestone, error) {
	row, err := r.q(ctx).UpdateMilestone(ctx, sqlc.UpdateMilestoneParams{
		MilestoneID: milestone.ID,
		ProcessID:   milestone.ProcessID,
		Date:        milestone.Date,
		Title:       milestone.Title,
		Content:     milestone.Content,
		Color:       milestone.Color,
	})
	if err != nil {
		return nil, err
	}

	return &row, nil
}

func (r *MilestoneRepository) DeleteMilestone(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteMilestone(ctx, id)
}

func (r *MilestoneRepository) ListMilestones(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]sqlc.Milestone, error) {
	return r.q(ctx).ListMilestones(ctx, sqlc.ListMilestonesParams{
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
	})
}

func (r *MilestoneRepository) CountMilestones(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
) (int64, error) {
	return r.q(ctx).CountMilestones(
		ctx,
		sqlc.CountMilestonesParams{
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
		},
	)
}

// OwnerChain returns the owner chain (for RBAC checks in the middleware).
func (r *MilestoneRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	row, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{ProjectOwner: row.ProjectOwner, ProcessOwner: row.ProcessOwner}, nil
}
