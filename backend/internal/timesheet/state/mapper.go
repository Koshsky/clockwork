package state

import (
	"github.com/Koshsky/erp-backend/internal/timesheet/state/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

type Mapper struct{}

func NewMapper() *Mapper {
	return &Mapper{}
}

func (m *Mapper) ToDTO(state *sqlc.State) *dto.StateResponse {
	if state == nil {
		return nil
	}
	return &dto.StateResponse{
		ID:          state.ID,
		Code:        state.Code,
		Name:        state.Name,
		IsAvailable: state.IsAvailable,
		Color:       nullable.StringPtr(state.Color),
	}
}

func (m *Mapper) ToDTOs(states []sqlc.State) []dto.StateResponse {
	if states == nil {
		return []dto.StateResponse{}
	}

	responses := make([]dto.StateResponse, len(states))
	for i, state := range states {
		responses[i] = *m.ToDTO(&state)
	}
	return responses
}
