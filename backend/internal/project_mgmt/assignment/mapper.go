package assignment

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository/sqlc"
)

type Mapper struct{}

func NewMapper() *Mapper {
	return &Mapper{}
}

func (m *Mapper) ToDTO(assignment *sqlc.Assignment) *dto.AssignmentResponse {
	if assignment == nil {
		return nil
	}
	return &dto.AssignmentResponse{
		ID:         assignment.ID,
		TaskID:     assignment.TaskID,
		ResourceID: assignment.ResourceID,
		Quantity:   int(assignment.Quantity),
	}
}

func (m *Mapper) ToDTOs(assignments []sqlc.Assignment) []dto.AssignmentResponse {
	if assignments == nil {
		return []dto.AssignmentResponse{}
	}
	responses := make([]dto.AssignmentResponse, len(assignments))
	for i, assignment := range assignments {
		responses[i] = *m.ToDTO(&assignment)
	}
	return responses
}
