package service

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type ProcessMapper struct{}

func NewProcessMapper() *ProcessMapper {
	return &ProcessMapper{}
}

func (m *ProcessMapper) ToDTO(process *sqlc.Process) *dto.ProcessResponse {
	if process == nil {
		return nil
	}
	return &dto.ProcessResponse{
		ID:            process.ID,
		OwnerID:       nullable.Int64Ptr(process.OwnerID),
		ResponsibleID: nullable.Int64Ptr(process.ResponsibleID),
		ProjectID:     process.ProjectID,
		Title:         process.Title,
		Color:         nullable.StringPtr(process.Color),
		StartDate:     process.StartDate,
		EndDate:       process.EndDate,
		Order:         int(process.SortOrder),
	}
}

func (m *ProcessMapper) ToDTOs(processes []sqlc.Process) []dto.ProcessResponse {
	if processes == nil {
		return []dto.ProcessResponse{}
	}

	responses := make([]dto.ProcessResponse, len(processes))
	for i, process := range processes {
		responses[i] = *m.ToDTO(&process)
	}
	return responses
}
