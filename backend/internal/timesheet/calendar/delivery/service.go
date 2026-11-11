package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/dto"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type CalendarService interface {
	GetCalendar(
		ctx context.Context,
		userID int64,
		scope rbac.ListScope,
		start, end date.Date,
	) (*dto.CalendarPlanning, error)
}
