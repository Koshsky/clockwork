package project

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type Mapper struct{}

func NewMapper() *Mapper {
	return &Mapper{}
}

func (m *Mapper) ToDTO(project *sqlc.Project) *dto.ProjectResponse {
	if project == nil {
		return nil
	}
	return &dto.ProjectResponse{
		ID:            project.ID,
		OwnerID:       nullable.Int64Ptr(project.OwnerID),
		ResponsibleID: nullable.Int64Ptr(project.ResponsibleID),
		Code:          project.Code,
		Color:         nullable.StringPtr(project.Color),
		StartDate:     project.StartDate,
		EndDate:       project.EndDate,
		Priority:      int(project.Priority),
	}
}

func (m *Mapper) ToDTOs(projects []sqlc.Project) []dto.ProjectResponse {
	if projects == nil {
		return []dto.ProjectResponse{}
	}

	responses := make([]dto.ProjectResponse, len(projects))
	for i, project := range projects {
		responses[i] = *m.ToDTO(&project)
	}
	return responses
}

// ToCreateDTO builds the create response: the project plus what the
// auto-create template added to it (counts fetched after the insert).
func (m *Mapper) ToCreateDTO(
	project *sqlc.Project,
	counts sqlc.CountAutoCreatedEntitiesRow,
) *dto.CreateProjectResponse {
	if project == nil {
		return nil
	}
	return &dto.CreateProjectResponse{
		ID:            project.ID,
		OwnerID:       nullable.Int64Ptr(project.OwnerID),
		ResponsibleID: nullable.Int64Ptr(project.ResponsibleID),
		Code:          project.Code,
		Color:         nullable.StringPtr(project.Color),
		StartDate:     project.StartDate,
		EndDate:       project.EndDate,
		Priority:      int(project.Priority),
		AutoCreated: dto.AutoCreatedCounts{
			Processes:   counts.Processes,
			Tasks:       counts.Tasks,
			Assignments: counts.Assignments,
		},
	}
}
