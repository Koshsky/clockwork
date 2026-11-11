package service

import (
	"database/sql"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/user/dto"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type UserMapper struct{}

func NewUserMapper() *UserMapper {
	return &UserMapper{}
}

func (m *UserMapper) ToDTO(user *sqlc.User) *dto.UserResponse {
	if user == nil {
		return nil
	}
	return &dto.UserResponse{
		ID:              user.ID,
		Name:            fullName(*user),
		LastName:        user.LastName,
		FirstName:       user.FirstName,
		MiddleName:      nullable.StringPtr(user.MiddleName),
		Username:        user.Username,
		Preset:          nullable.StringPtr(user.Preset),
		ManagerID:       nullable.Int64Ptr(user.ManagerID),
		Position:        user.Position,
		HireDate:        datePtr(fromDate(user.HireDate)),
		TerminationDate: datePtr(fromDate(user.TerminationDate)),
		PasswordHash:    user.PasswordHash,
		CreatedAt:       user.CreatedAt,
	}
}

func (m *UserMapper) ToDTOs(users []sqlc.User) []dto.UserResponse {
	if users == nil {
		return []dto.UserResponse{}
	}
	responses := make([]dto.UserResponse, len(users))
	for i, user := range users {
		responses[i] = *m.ToDTO(&user)
	}
	return responses
}

// ToCreateUser builds the user row from the create request; NULL-able fields
// keep their native pgtype representations (the repository inserts them
// directly into sqlc params).
func (m *UserMapper) ToCreateUser(req dto.CreateUserRequest) sqlc.User {
	return sqlc.User{
		LastName:        req.LastName,
		FirstName:       req.FirstName,
		MiddleName:      nullable.ToString(normalizeMiddle(req.MiddleName)),
		Username:        req.Username,
		Preset:          nullable.ToString(req.Preset),
		PasswordHash:    req.PasswordHash,
		ManagerID:       nullable.ToInt8(req.ManagerID),
		Position:        req.Position,
		HireDate:        toDate(timePtr(req.HireDate)),
		TerminationDate: toDate(timePtr(req.TerminationDate)),
	}
}

// ApplyUpdateToUser applies the patch of an update request to a fetched row.
func (m *UserMapper) ApplyUpdateToUser(user *sqlc.User, req dto.UpdateUserRequest) {
	if user == nil {
		return
	}

	if req.LastName != nil {
		user.LastName = *req.LastName
	}
	if req.FirstName != nil {
		user.FirstName = *req.FirstName
	}
	if req.MiddleName != nil {
		user.MiddleName = nullable.ToString(normalizeMiddle(req.MiddleName))
	}
	if req.Username != nil {
		user.Username = *req.Username
	}
	if req.Preset != nil {
		if *req.Preset == "" {
			user.Preset = sql.NullString{}
		} else {
			user.Preset = sql.NullString{String: *req.Preset, Valid: true}
		}
	}
	if req.ManagerID != nil {
		user.ManagerID = nullable.ToInt8(req.ManagerID)
	}
	if req.Position != nil {
		user.Position = *req.Position
	}
	if req.HireDate != nil {
		t := req.HireDate.Time()
		user.HireDate = pgtype.Date{Time: t, Valid: true}
	}
	if req.TerminationDate != nil {
		t := req.TerminationDate.Time()
		user.TerminationDate = pgtype.Date{Time: t, Valid: true}
	}
}

func (m *UserMapper) ToStateDTOs(states []sqlc.ListStatesByUserRangeRow) []dto.UserStateResponse {
	if states == nil {
		return []dto.UserStateResponse{}
	}

	responses := make([]dto.UserStateResponse, len(states))
	for i, state := range states {
		responses[i] = dto.UserStateResponse{
			ID:          state.ID,
			StateID:     state.StateID,
			StateCode:   state.StateCode,
			StateName:   state.StateName,
			IsAvailable: state.IsAvailable,
			StartDate:   state.StartDate,
			EndDate:     state.EndDate,
		}
	}
	return responses
}

// ToBatchStateDTOs maps batch rows (ListStatesBatch): the items carry the
// worker's user_id so the caller can group them without re-reading the row.
func (m *UserMapper) ToBatchStateDTOs(states []sqlc.ListStatesByUsersRangeRow) []dto.UserStateResponse {
	if states == nil {
		return []dto.UserStateResponse{}
	}

	responses := make([]dto.UserStateResponse, len(states))
	for i, state := range states {
		responses[i] = dto.UserStateResponse{
			ID:          state.ID,
			UserID:      state.UserID,
			StateID:     state.StateID,
			StateCode:   state.StateCode,
			StateName:   state.StateName,
			IsAvailable: state.IsAvailable,
			StartDate:   state.StartDate,
			EndDate:     state.EndDate,
		}
	}
	return responses
}

// fullName returns the full name "Last First Middle" (without empty parts).
func fullName(u sqlc.User) string {
	parts := []string{}
	if u.LastName != "" {
		parts = append(parts, u.LastName)
	}
	if u.FirstName != "" {
		parts = append(parts, u.FirstName)
	}
	if u.MiddleName.Valid && u.MiddleName.String != "" {
		parts = append(parts, u.MiddleName.String)
	}
	return strings.Join(parts, " ")
}

func datePtr(t *time.Time) *date.Date {
	if t == nil {
		return nil
	}
	d := date.From(*t)
	return &d
}

func timePtr(d *date.Date) *time.Time {
	if d == nil {
		return nil
	}
	t := d.Time()
	return &t
}

// fromDate unwraps a nullable date (pgtype.Date) into [time.Time].
func fromDate(v pgtype.Date) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}

// toDate wraps [time.Time] into a nullable date (pgtype.Date).
func toDate(v *time.Time) pgtype.Date {
	if v == nil {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: *v, Valid: true}
}

// normalizeMiddle converts an empty middle-name string to nil (no middle name).
func normalizeMiddle(p *string) *string {
	if p != nil && *p == "" {
		return nil
	}
	return p
}
