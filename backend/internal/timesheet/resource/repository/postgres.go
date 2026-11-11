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
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type ResourceRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewResourceRepository builds the ResourceRepository repository.
func NewResourceRepository(logger *slog.Logger, pool *pgxpool.Pool) *ResourceRepository {
	return &ResourceRepository{
		logger: logger.With("component", "resource_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *ResourceRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *ResourceRepository) CreateResource(
	ctx context.Context,
	code, title string,
	color *string,
	ownerID *int64,
) (*sqlc.ListResourcesRow, error) {
	row, err := r.q(ctx).CreateResource(ctx, sqlc.CreateResourceParams{
		Title:   title,
		Code:    code,
		Color:   nullable.ToString(color),
		OwnerID: ownerIDValue(ownerID),
	})
	if err != nil {
		// Idempotent create: the active code already exists (ON CONFLICT
		// inserted nothing) — this is a business-key conflict, not an internal error.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errapi.Conflict("resource with this code already exists")
		}
		return nil, err
	}

	return r.withEmployeesCount(ctx, row)
}

func (r *ResourceRepository) FindResource(ctx context.Context, id int64) (*sqlc.ListResourcesRow, error) {
	row, err := r.q(ctx).FindResource(ctx, id)
	if err != nil {
		return nil, err
	}

	converted := sqlc.ListResourcesRow(row)
	return &converted, nil
}

func (r *ResourceRepository) UpdateResource(
	ctx context.Context,
	id int64,
	code, title string,
	color *string,
	ownerID *int64,
) (*sqlc.ListResourcesRow, error) {
	row, err := r.q(ctx).UpdateResource(ctx, sqlc.UpdateResourceParams{
		ResourceID: id,
		Title:      title,
		Code:       code,
		Color:      nullable.ToString(color),
		OwnerID:    ownerIDValue(ownerID),
	})
	if err != nil {
		return nil, err
	}

	return r.withEmployeesCount(ctx, row)
}

func (r *ResourceRepository) DeleteResource(ctx context.Context, id int64) error {
	return r.q(ctx).DeleteResource(ctx, id)
}

func (r *ResourceRepository) ListResources(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
	limit, offset int,
) ([]sqlc.ListResourcesRow, error) {
	return r.q(ctx).ListResources(ctx, sqlc.ListResourcesParams{
		ScAll:              scope.All,
		ScSelf:             scope.Self,
		ScNone:             scope.None,
		UserID:             userID,
		OwnerID:            ownerID,
		PageLimit:          int64(limit),
		PageOffset:         int64(offset),
		ScProjectResources: scope.ProjectResources,
	})
}

func (r *ResourceRepository) CountResources(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	ownerID int64,
) (int64, error) {
	return r.q(ctx).CountResources(
		ctx,
		sqlc.CountResourcesParams{
			ScAll:              scope.All,
			ScSelf:             scope.Self,
			ScNone:             scope.None,
			UserID:             userID,
			OwnerID:            ownerID,
			ScProjectResources: scope.ProjectResources,
		},
	)
}

func (r *ResourceRepository) ListResourcesByOwnerID(
	ctx context.Context,
	ownerID int64,
) ([]sqlc.ListResourcesRow, error) {
	rows, err := r.q(ctx).ListResourcesByOwnerID(ctx, ownerID)
	if err != nil {
		return nil, err
	}

	resources := make([]sqlc.ListResourcesRow, len(rows))
	for i, row := range rows {
		resources[i] = sqlc.ListResourcesRow(row)
	}
	return resources, nil
}

// withEmployeesCount enriches the resource row with the members count.
func (r *ResourceRepository) withEmployeesCount(
	ctx context.Context,
	row sqlc.Resource,
) (*sqlc.ListResourcesRow, error) {
	count, err := r.q(ctx).CountMembersByResourceID(ctx, row.ID)
	if err != nil {
		return nil, err
	}

	return &sqlc.ListResourcesRow{
		ID:             row.ID,
		Code:           row.Code,
		Title:          row.Title,
		Color:          row.Color,
		OwnerID:        row.OwnerID,
		EmployeesCount: count,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}, nil
}

// ListMembersByResourceID returns the users attached to a resource.
func (r *ResourceRepository) ListMembersByResourceID(
	ctx context.Context,
	resourceID int64,
) ([]sqlc.ListMembersByResourceIDRow, error) {
	return r.q(ctx).ListMembersByResourceID(ctx, resourceID)
}

func (r *ResourceRepository) AddMember(ctx context.Context, resourceID, userID int64) error {
	return r.q(ctx).AddMember(ctx, sqlc.AddMemberParams{ResourceID: resourceID, UserID: userID})
}

func (r *ResourceRepository) RemoveMember(ctx context.Context, resourceID, userID int64) error {
	return r.q(ctx).RemoveMember(ctx, sqlc.RemoveMemberParams{ResourceID: resourceID, UserID: userID})
}

// FindUserManager returns the manager id of a user (nil — no manager).
func (r *ResourceRepository) FindUserManager(ctx context.Context, userID int64) (*int64, error) {
	managerID, err := r.q(ctx).FindUserManager(ctx, userID)
	if err != nil {
		return nil, err
	}
	return nullable.Int64Ptr(managerID), nil
}

// ListAbsence returns the absence ranges (is_available=false states) of the
// resource members overlapping [start, end].
func (r *ResourceRepository) ListAbsence(
	ctx context.Context,
	resourceID int64,
	start, end date.Date,
) ([]sqlc.ListResourceAbsenceRow, error) {
	return r.q(ctx).ListResourceAbsence(ctx, sqlc.ListResourceAbsenceParams{
		ResourceID: resourceID,
		StartDate:  start,
		EndDate:    end,
	})
}

// ownerIDValue unwraps a nullable owner into a required value.
func ownerIDValue(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

// OwnerChain returns the owner chain (for RBAC checks in the middleware).
func (r *ResourceRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	owner, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{Owner: owner}, nil
}
