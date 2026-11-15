package delivery

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/dto"
)

type AssignmentService interface {
	ListAssignments(
		ctx context.Context,
		userID int64,
		scope access.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]dto.AssignmentResponse, int64, error)
	FindAssignment(ctx context.Context, id int64) (*dto.AssignmentResponse, error)
	CreateAssignment(ctx context.Context, assignment dto.CreateAssignmentRequest) (*dto.AssignmentResponse, error)
	DeleteAssignment(ctx context.Context, id int64) error
	UpdateAssignment(
		ctx context.Context,
		id int64,
		assignment dto.UpdateAssignmentRequest,
	) (*dto.AssignmentResponse, error)
}
