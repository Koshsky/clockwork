package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository/sqlc"
)

type TaskDependencyMapper struct{}

// ToDTO converts a dependency row to the API response shape.
func (m *TaskDependencyMapper) ToDTO(d *sqlc.TaskDependency) *dto.DependencyResponse {
	if d == nil {
		return nil
	}
	return &dto.DependencyResponse{
		ID:              d.ID,
		TaskID:          d.TaskID,
		DependsOnTaskID: d.DependsOnTaskID,
		Type:            d.Type,
	}
}

// ToDTOs converts a dependency row list (nil → empty slice).
func (m *TaskDependencyMapper) ToDTOs(deps []sqlc.TaskDependency) []dto.DependencyResponse {
	if deps == nil {
		return []dto.DependencyResponse{}
	}
	out := make([]dto.DependencyResponse, len(deps))
	for i, d := range deps {
		out[i] = *m.ToDTO(&d)
	}
	return out
}
