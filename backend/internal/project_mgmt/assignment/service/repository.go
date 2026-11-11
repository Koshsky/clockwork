package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository/sqlc"
)

type AssignmentRepository interface {
	CreateAssignment(ctx context.Context, taskID, resourceID int64, quantity int) (*sqlc.Assignment, error)
	FindAssignment(ctx context.Context, id int64) (*sqlc.Assignment, error)
	UpdateAssignment(ctx context.Context, assignment sqlc.Assignment, quantity int) (*sqlc.Assignment, error)
	DeleteAssignment(ctx context.Context, id int64) error
	ListAssignments(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]sqlc.Assignment, error)
	CountAssignments(ctx context.Context, userID int64, scope rbac.ListScope, ownerID int64) (int64, error)
}
