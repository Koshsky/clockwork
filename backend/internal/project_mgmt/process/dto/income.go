package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type UpdateProcessRequest struct {
	Title         *string    `json:"title"          example:"Инсталляция"`
	Color         *string    `json:"color"          example:"#0f83c4"`
	StartDate     *date.Date `json:"start_date"     example:"2026-01-01"  format:"date"`
	EndDate       *date.Date `json:"end_date"       example:"2026-02-01"  format:"date"`
	OwnerID       *int64     `json:"owner_id"       example:"1"`
	ResponsibleID *int64     `json:"responsible_id" example:"2"`
	ProjectID     *int64     `json:"project_id"     example:"1"`
}

type CreateProcessRequest struct {
	ProjectID     int64     `json:"project_id"     example:"1"`
	Title         string    `json:"title"          example:"Инсталляция"`
	Color         *string   `json:"color"          example:"#0f83c4"`
	StartDate     date.Date `json:"start_date"     example:"2026-01-01"  format:"date"`
	EndDate       date.Date `json:"end_date"       example:"2026-02-01"  format:"date"`
	OwnerID       *int64    `json:"owner_id"       example:"1"`
	ResponsibleID *int64    `json:"responsible_id" example:"2"`
}
