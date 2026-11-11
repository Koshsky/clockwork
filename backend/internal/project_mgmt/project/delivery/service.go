package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/dto"
)

type ProjectService interface {
	ListProjects(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		ownerID int64,
		limit, offset int,
	) ([]dto.ProjectResponse, int64, error)
	FindProject(ctx context.Context, id int64) (*dto.ProjectResponse, error)
	CreateProject(
		ctx context.Context,
		project dto.CreateProjectRequest,
		userID int64,
		forceSelfOwner bool,
	) (*dto.CreateProjectResponse, error)
	UpdateProject(ctx context.Context, id int64, project dto.UpdateProjectRequest) (*dto.ProjectResponse, error)
	DeleteProject(ctx context.Context, id int64) error
}
