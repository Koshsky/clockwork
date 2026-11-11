package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/planning/repository/sqlc"
)

type PlanningRepository interface {
	ListProjects(ctx context.Context, userID int64, scope rbac.ListScope) ([]sqlc.Project, error)
	ListProjectsByIDs(ctx context.Context, ids []int64, userID int64, scope rbac.ListScope) ([]sqlc.Project, error)
	ListProcesses(ctx context.Context, userID int64, scope rbac.ListScope) ([]sqlc.ListProcessesRow, error)
	ListProcessesByTaskScope(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
	) ([]sqlc.ListProcessesByTaskScopeRow, error)
	ListResources(ctx context.Context, userID int64, scope rbac.ListScope) ([]sqlc.Resource, error)

	ListMilestonesByProcessIDs(ctx context.Context, processIDs []int64) ([]sqlc.Milestone, error)
	ListTasksByProcessIDs(
		ctx context.Context,
		processIDs []int64,
		userID int64,
		scope rbac.ListScope,
	) ([]sqlc.Task, error)
	ListAssignmentsByTaskIDs(ctx context.Context, taskIDs []int64) ([]sqlc.Assignment, error)
	ListTaskCommentCountsByTaskIDs(ctx context.Context, taskIDs []int64) (map[int64]int64, error)
	ListTaskDependenciesByProcessIDs(
		ctx context.Context,
		processIDs []int64,
	) ([]sqlc.ListTaskDependenciesByProcessIDsRow, error)
}
