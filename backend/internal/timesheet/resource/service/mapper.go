package service

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/timesheet/resource/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type ResourceMapper struct{}

func NewResourceMapper() *ResourceMapper {
	return &ResourceMapper{}
}

func (m *ResourceMapper) ToDTO(resource *sqlc.ListResourcesRow) *dto.ResourceResponse {
	if resource == nil {
		return nil
	}
	return &dto.ResourceResponse{
		ID:             resource.ID,
		Code:           resource.Code,
		Title:          resource.Title,
		Color:          nullable.StringPtr(resource.Color),
		OwnerID:        &resource.OwnerID,
		EmployeesCount: int(resource.EmployeesCount),
	}
}

func (m *ResourceMapper) ToDTOs(resources []sqlc.ListResourcesRow) []dto.ResourceResponse {
	if resources == nil {
		return []dto.ResourceResponse{}
	}

	responses := make([]dto.ResourceResponse, len(resources))
	for i, resource := range resources {
		responses[i] = *m.ToDTO(&resource)
	}
	return responses
}

func (m *ResourceMapper) ToMemberDTO(member *sqlc.ListMembersByResourceIDRow) *dto.ResourceMemberResponse {
	if member == nil {
		return nil
	}
	return &dto.ResourceMemberResponse{
		ID:              member.ID,
		Name:            member.Name,
		Preset:          nullable.StringPtr(member.Preset),
		Position:        member.Position,
		ManagerID:       nullable.Int64Ptr(member.ManagerID),
		HireDate:        datePtr(fromDate(member.HireDate)),
		TerminationDate: datePtr(fromDate(member.TerminationDate)),
	}
}

func (m *ResourceMapper) ToMemberDTOs(members []sqlc.ListMembersByResourceIDRow) []dto.ResourceMemberResponse {
	if members == nil {
		return []dto.ResourceMemberResponse{}
	}
	responses := make([]dto.ResourceMemberResponse, len(members))
	for i, member := range members {
		responses[i] = *m.ToMemberDTO(&member)
	}
	return responses
}

func (m *ResourceMapper) ToAbsenceDTOs(absences []sqlc.ListResourceAbsenceRow) []dto.ResourceAbsenceResponse {
	if absences == nil {
		return []dto.ResourceAbsenceResponse{}
	}
	responses := make([]dto.ResourceAbsenceResponse, len(absences))
	for i, a := range absences {
		responses[i] = dto.ResourceAbsenceResponse{
			UserID:    a.UserID,
			UserName:  a.UserName,
			StateID:   a.StateID,
			StateCode: a.StateCode,
			StateName: a.StateName,
			StartDate: a.StartDate,
			EndDate:   a.EndDate,
		}
	}
	return responses
}

// fromDate unwraps a nullable date (pgtype.Date) into [time.Time].
func fromDate(v pgtype.Date) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}

func datePtr(t *time.Time) *date.Date {
	if t == nil {
		return nil
	}
	d := date.From(*t)
	return &d
}
