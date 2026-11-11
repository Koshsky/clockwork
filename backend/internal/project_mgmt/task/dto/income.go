package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type UpdateTaskRequest struct {
	// ProcessID is intentionally absent: a task never changes its process.
	// ParentID is absent too: the parent is fixed at creation.
	OwnerID       *int64     `json:"owner_id"       example:"1"`
	ResponsibleID *int64     `json:"responsible_id" example:"2"`
	Title         *string    `json:"title"          example:"Пуско-наладочные работы"`
	Color         *string    `json:"color"          example:"#0f83c4"`
	Status        *string    `json:"status"         example:"in_progress"`
	StartDate     *date.Date `json:"start_date"     example:"2026-01-01"              format:"date"`
	EndDate       *date.Date `json:"end_date"       example:"2026-02-01"              format:"date"`
}

type CreateTaskRequest struct {
	ProcessID int64 `json:"process_id" example:"1"`
	// ParentID — optional subtask (operation) link: task of the given parent.
	// When set, process_id must point to the parent's process; dates and
	// owner may be omitted and are inherited from the parent by the service.
	ParentID      *int64     `json:"parent_id"      example:"10"`
	OwnerID       *int64     `json:"owner_id"       example:"1"`
	ResponsibleID *int64     `json:"responsible_id" example:"2"`
	Title         string     `json:"title"          example:"Пуско-наладочные работы"`
	Color         *string    `json:"color"          example:"#0f83c4"`
	Status        *string    `json:"status"         example:"not_started"`
	StartDate     *date.Date `json:"start_date"     example:"2026-01-01"              format:"date"`
	EndDate       *date.Date `json:"end_date"       example:"2026-02-01"              format:"date"`
}
