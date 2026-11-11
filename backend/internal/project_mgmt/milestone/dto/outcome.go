package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type MilestoneResponse struct {
	ID        int64     `json:"id"         example:"1"`
	ProcessID int64     `json:"process_id" example:"1"`
	Title     string    `json:"title"      example:"Телевидение"`
	Content   string    `json:"content"    example:"Приедут с России1"`
	Color     *string   `json:"color"      example:"#0f83c4"`
	Date      date.Date `json:"date"       example:"2026-01-01"        format:"date"`
}
