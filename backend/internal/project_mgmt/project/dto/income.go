package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type CreateProjectRequest struct {
	OwnerID       *int64    `json:"owner_id"       example:"1"`
	ResponsibleID *int64    `json:"responsible_id" example:"2"`
	Code          string    `json:"code"           example:"КО_001"`
	Color         *string   `json:"color"          example:"#0f83c4"`
	StartDate     date.Date `json:"start_date"     example:"2026-01-01" format:"date"`
	EndDate       date.Date `json:"end_date"       example:"2026-02-01" format:"date"`
	Priority      int       `json:"priority"       example:"2"`
}

// UpdateProjectRequest — partial update. A nil pointer means "leave unchanged";
// responsible_id=0 clears the responsible person (0 is never a valid user id).
type UpdateProjectRequest struct {
	OwnerID       *int64     `json:"owner_id"       example:"1"`
	ResponsibleID *int64     `json:"responsible_id" example:"2"`
	Code          *string    `json:"code"           example:"1"`
	Color         *string    `json:"color"          example:"#0f83c4"`
	StartDate     *date.Date `json:"start_date"     example:"2026-01-01" format:"date"`
	EndDate       *date.Date `json:"end_date"       example:"2026-02-01" format:"date"`
	Priority      *int       `json:"priority"       example:"2"`
}
