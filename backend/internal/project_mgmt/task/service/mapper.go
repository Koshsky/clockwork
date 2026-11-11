package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type TaskMapper struct{}

func NewTaskMapper() *TaskMapper {
	return &TaskMapper{}
}

func (m *TaskMapper) ToDTO(task *sqlc.Task) *dto.TaskResponse {
	if task == nil {
		return nil
	}
	return &dto.TaskResponse{
		ID:            task.ID,
		ProcessID:     task.ProcessID,
		ParentID:      nullable.Int64Ptr(task.ParentID),
		OwnerID:       nullable.Int64Ptr(task.OwnerID),
		ResponsibleID: nullable.Int64Ptr(task.ResponsibleID),
		Title:         task.Title,
		Color:         nullable.StringPtr(task.Color),
		Status:        task.Status,
		StartDate:     task.StartDate,
		EndDate:       task.EndDate,
		Order:         int(task.SortOrder),
	}
}

func (m *TaskMapper) ToDTOs(tasks []sqlc.Task) []dto.TaskResponse {
	if tasks == nil {
		return []dto.TaskResponse{}
	}

	responses := make([]dto.TaskResponse, len(tasks))
	for i, task := range tasks {
		responses[i] = *m.ToDTO(&task)
	}
	return responses
}
