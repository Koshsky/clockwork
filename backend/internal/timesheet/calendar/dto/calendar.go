package dto

import (
	"time"

	"github.com/Koshsky/erp-backend/pkg/date"
)

type CalendarPlanning struct {
	Resources []ResourceCalendar `json:"resources"`
}

type ResourceCalendar struct {
	ResourceID int64                `json:"resource_id" example:"1"`
	Title      string               `json:"title"       example:"Инженер"`
	Code       string               `json:"code"        example:"И"`
	Periods    []AvailabilityPeriod `json:"periods"`
}

// AvailabilityPeriod is a constant-availability range of a category: between
// bounds (hires/terminations/state intervals) active and unavailable sets do not change.
type AvailabilityPeriod struct {
	StartDate   date.Date `json:"start_date"  example:"2026-07-15" format:"date"`
	EndDate     date.Date `json:"end_date"    example:"2026-07-19" format:"date"`
	Capacity    int       `json:"capacity"    example:"7"`
	Unavailable int       `json:"unavailable" example:"0"`
	Available   int       `json:"available"   example:"7"`
}

// ResourceInfo is reference info about a category for the calendar.
type ResourceInfo struct {
	ID      int64  `json:"id"       example:"1"`
	Title   string `json:"title"    example:"Инженер"`
	Code    string `json:"code"     example:"И"`
	OwnerID *int64 `json:"owner_id" example:"3"`
}

// CalendarMember is a resource member (worker) with their work interval for the calendar.
type CalendarMember struct {
	UserID          int64
	ResourceID      int64
	HireDate        *time.Time
	TerminationDate *time.Time
}

// UnavailableRange is an absence interval (is_available = false) for the calendar.
type UnavailableRange struct {
	ResourceID int64
	StartDate  time.Time
	EndDate    time.Time
}
