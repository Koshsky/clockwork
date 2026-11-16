package service

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/planning/repository/sqlc"
)

type PlanningRepository interface {
	ListProjects(ctx context.Context, userID int64, scope access.ListScope) ([]sqlc.Project, error)
	ListProjectsByIDs(ctx context.Context, ids []int64, userID int64, scope access.ListScope) ([]sqlc.Project, error)
	ListProcesses(ctx context.Context, userID int64, scope access.ListScope) ([]sqlc.ListProcessesRow, error)
	ListProcessesByTaskScope(
		ctx context.Context,
		userID int64,
		scope access.ListScope,
	) ([]sqlc.ListProcessesByTaskScopeRow, error)
	ListResources(ctx context.Context, userID int64, scope access.ListScope) ([]sqlc.Resource, error)

	ListMilestonesByProcessIDs(ctx context.Context, processIDs []int64) ([]sqlc.Milestone, error)
	ListTasksByProcessIDs(
		ctx context.Context,
		processIDs []int64,
		userID int64,
		scope access.ListScope,
	) ([]sqlc.Task, error)
	ListAssignmentsByTaskIDs(ctx context.Context, taskIDs []int64) ([]sqlc.Assignment, error)
	ListTaskCommentCountsByTaskIDs(ctx context.Context, taskIDs []int64) (map[int64]int64, error)
	ListTaskDependenciesByProcessIDs(
		ctx context.Context,
		processIDs []int64,
	) ([]sqlc.ListTaskDependenciesByProcessIDsRow, error)
}
