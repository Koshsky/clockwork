package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type ProcessResponse struct {
	ID            int64     `json:"id"             example:"1"`
	OwnerID       *int64    `json:"owner_id"       example:"1"`
	ResponsibleID *int64    `json:"responsible_id" example:"2"`
	ProjectID     int64     `json:"project_id"     example:"1"`
	Title         string    `json:"title"          example:"Инсталляция"`
	Color         *string   `json:"color"          example:"#0f83c4"`
	StartDate     date.Date `json:"start_date"     example:"2026-01-01"  format:"date"`
	EndDate       date.Date `json:"end_date"       example:"2026-02-01"  format:"date"`
	// Order of the process within its project (ascending display order).
	Order int `json:"order" example:"1"`
}

// ReorderProcessRequest — the complete ordered list of the project's active
// processes; the server rewrites their order values from the list positions.
type ReorderProcessRequest struct {
	ProjectID int64   `json:"project_id" example:"1"`
	IDs       []int64 `json:"ids"`
}
