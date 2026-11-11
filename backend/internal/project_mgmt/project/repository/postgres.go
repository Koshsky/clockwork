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
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type ProjectRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewProjectRepository builds the ProjectRepository repository.
func NewProjectRepository(logger *slog.Logger, pool *pgxpool.Pool) *ProjectRepository {
	return &ProjectRepository{
		logger: logger.With("component", "project_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *ProjectRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *ProjectRepository) CreateProject(
	ctx context.Context,
	ownerID *int64,
	responsibleID *int64,
	code string,
	color *string,
	startDate, endDate date.Date,
	priority int,
) (*sqlc.Project, error) {
	created, err := r.q(ctx).CreateProject(ctx, sqlc.CreateProjectParams{
		Code:          code,
		OwnerID:       nullable.ToInt8(ownerID),
		ResponsibleID: nullable.ToInt8(responsibleID),
		Color:         nullable.ToString(color),
		StartDate:     startDate,
		EndDate:       endDate,
		Priority:      int64(priority),
	})
	if err != nil {
		// Idempotent create: the active code already exists (ON CONFLICT inserted
		// nothing) — this is not an internal error but a key conflict.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errapi.Conflict("project with this code already exists")
		}
		return nil, mapProjectCreateError(err)
	}

	return &created, nil
}

func (r *ProjectRepository) FindProject(ctx context.Context, id int64) (*sqlc.Project, error) {
	project, err := r.q(ctx).FindProject(ctx, id)
	if err != nil {
		return nil, err
	}

	return &project, nil
}

func (r *ProjectRepository) UpdateProject(
	ctx context.Context,
	project sqlc.Project,
	priority int,
) (*sqlc.Project, error) {
	updated, err := r.q(ctx).UpdateProject(ctx, sqlc.UpdateProjectParams{
		ProjectID:     project.ID,
		OwnerID:       project.OwnerID,
		ResponsibleID: project.ResponsibleID,
		Code:          project.Code,
		Color:         project.Color,
		Priority:      int64(priority),
		StartDate:     project.StartDate,
		EndDate:       project.EndDate,
	})
	if err != nil {
		return nil, err
	}

	return &updated, nil
}

func (r *ProjectRepository) DeleteProject(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteProject(ctx, id)
}

func (r *ProjectRepository) ListProjects(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]sqlc.Project, error) {
	return r.q(ctx).ListProjects(ctx, sqlc.ListProjectsParams{
		ScAll:             scope.All,
		ScSelf:            scope.Self,
		UserID:            userID,
		ScDown:            scope.Down,
		ScNone:            scope.None,
		OwnerID:           ownerID,
		PageLimit:         int64(limit),
		PageOffset:        int64(offset),
		ScProcessProjects: scope.ProcessProjects,
	})
}

func (r *ProjectRepository) CountProjects(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
) (int64, error) {
	return r.q(ctx).CountProjects(
		ctx,
		sqlc.CountProjectsParams{
			ScAll:             scope.All,
			ScSelf:            scope.Self,
			UserID:            userID,
			ScDown:            scope.Down,
			ScNone:            scope.None,
			OwnerID:           ownerID,
			ScProcessProjects: scope.ProcessProjects,
		},
	)
}

// AutoCreatedCounts returns what the auto-create trigger (V8) created for the
// project on insert (processes/tasks/assignments). All zero when the template
// is disabled or empty.
func (r *ProjectRepository) AutoCreatedCounts(
	ctx context.Context,
	projectID int64,
) (sqlc.CountAutoCreatedEntitiesRow, error) {
	return r.q(ctx).CountAutoCreatedEntities(ctx, projectID)
}

// OwnerChain returns the owner chain (for RBAC checks in the middleware).
func (r *ProjectRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	owner, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{ProjectOwner: owner}, nil
}
