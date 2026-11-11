package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type ResourceResponse struct {
	ID             int64   `json:"id"              example:"1"`
	Code           string  `json:"code"            example:"М"`
	Title          string  `json:"title"           example:"Монтажник"`
	Color          *string `json:"color"           example:"#0f83c4"`
	OwnerID        *int64  `json:"owner_id"        example:"3"`
	EmployeesCount int     `json:"employees_count" example:"4"`
}

// ResourceMemberResponse is a user attached to a resource.
type ResourceMemberResponse struct {
	ID              int64      `json:"id"               example:"7"`
	Name            string     `json:"name"             example:"Иванов Иван Иванович"`
	Preset          *string    `json:"preset"           example:"worker"`
	Position        string     `json:"position"         example:"Инженер 2 категории"`
	ManagerID       *int64     `json:"manager_id"       example:"5"`
	HireDate        *date.Date `json:"hire_date"        example:"2024-01-15"           format:"date"`
	TerminationDate *date.Date `json:"termination_date" example:"2026-12-31"           format:"date"`
}

// ResourceAbsenceResponse is a member's absence range with the state reason.
type ResourceAbsenceResponse struct {
	UserID    int64     `json:"user_id"    example:"7"`
	UserName  string    `json:"user_name"  example:"Иванов Иван Иванович"`
	StateID   int64     `json:"state_id"   example:"4"`
	StateCode string    `json:"state_code" example:"ОТП"`
	StateName string    `json:"state_name" example:"Отпуск"`
	StartDate date.Date `json:"start_date" example:"2026-07-20"           format:"date"`
	EndDate   date.Date `json:"end_date"   example:"2026-08-02"           format:"date"`
}
