package milestone

import (
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type Mapper struct{}

func NewMapper() *Mapper {
	return &Mapper{}
}

func (m *Mapper) ToDTO(milestone *sqlc.Milestone) *dto.MilestoneResponse {
	if milestone == nil {
		return nil
	}
	return &dto.MilestoneResponse{
		ID:        milestone.ID,
		Title:     milestone.Title,
		Content:   milestone.Content,
		Color:     nullable.StringPtr(milestone.Color),
		Date:      milestone.Date,
		ProcessID: milestone.ProcessID,
	}
}

func (m *Mapper) ToDTOs(milestones []sqlc.Milestone) []dto.MilestoneResponse {
	if milestones == nil {
		return []dto.MilestoneResponse{}
	}

	responses := make([]dto.MilestoneResponse, len(milestones))
	for i, milestone := range milestones {
		responses[i] = *m.ToDTO(&milestone)
	}
	return responses
}
