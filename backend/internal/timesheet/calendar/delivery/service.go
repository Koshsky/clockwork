package delivery

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/dto"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type CalendarService interface {
	GetCalendar(
		ctx context.Context,
		userID int64,
		scope access.ListScope,
		start, end date.Date,
	) (*dto.CalendarPlanning, error)
}
