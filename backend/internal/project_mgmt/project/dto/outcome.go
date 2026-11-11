package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type ProjectResponse struct {
	ID            int64     `json:"id"`
	OwnerID       *int64    `json:"owner_id"`
	ResponsibleID *int64    `json:"responsible_id"`
	Code          string    `json:"code"`
	Color         *string   `json:"color"`
	StartDate     date.Date `json:"start_date"`
	EndDate       date.Date `json:"end_date"`
	Priority      int       `json:"priority"`
}

// AutoCreatedCounts — how many processes/tasks/assignments the auto-create
// template (DB trigger V8) added to a newly created project.
type AutoCreatedCounts struct {
	Processes   int64 `json:"processes"`
	Tasks       int64 `json:"tasks"`
	Assignments int64 `json:"assignments"`
}

// CreateProjectResponse — the created project plus what the auto-create
// template added to it (all-zero counts when the template is disabled/empty).
type CreateProjectResponse struct {
	ID            int64             `json:"id"`
	OwnerID       *int64            `json:"owner_id"`
	ResponsibleID *int64            `json:"responsible_id"`
	Code          string            `json:"code"`
	Color         *string           `json:"color"`
	StartDate     date.Date         `json:"start_date"`
	EndDate       date.Date         `json:"end_date"`
	Priority      int               `json:"priority"`
	AutoCreated   AutoCreatedCounts `json:"auto_created"`
}
