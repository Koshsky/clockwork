package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type UpdateMilestoneRequest struct {
	Title     *string    `json:"title"      example:"Телевидение"`
	Content   *string    `json:"content"    example:"Приедут с России1"`
	Color     *string    `json:"color"      example:"#0f83c4"`
	Date      *date.Date `json:"date"       example:"2026-01-01"        format:"date"`
	ProcessID *int64     `json:"process_id" example:"1"`
}

type CreateMilestoneRequest struct {
	ProcessID int64     `json:"process_id" example:"1"`
	Title     string    `json:"title"      example:"Телевидение"`
	Content   string    `json:"content"    example:"Приедут с России1"`
	Color     *string   `json:"color"      example:"#0f83c4"`
	Date      date.Date `json:"date"       example:"2026-01-01"        format:"date"`
}
