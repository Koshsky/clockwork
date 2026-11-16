package calendar

import (
	"context"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type Repository interface {
	ListResources(ctx context.Context, userID int64, scope access.ListScope) ([]sqlc.ListResourcesRow, error)
	ListEmployeesForCalendar(ctx context.Context, start, end date.Date) ([]sqlc.ListEmployeesForCalendarRow, error)
	ListUnavailableRanges(ctx context.Context, start, end date.Date) ([]sqlc.ListUnavailableRangesRow, error)
}
