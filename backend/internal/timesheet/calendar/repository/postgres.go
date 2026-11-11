//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type CalendarRepository struct {
	logger *slog.Logger
	db     *sqlc.Queries
}

// NewCalendarRepository builds the CalendarRepository repository.
func NewCalendarRepository(logger *slog.Logger, pool *pgxpool.Pool) *CalendarRepository {
	return &CalendarRepository{
		logger: logger.With("component", "calendar_repository"),
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *CalendarRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

// ListResources returns resources within the caller's resource view zone; an
// empty zone (no resource view rule) includes all rows (reference fallback).
func (r *CalendarRepository) ListResources(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.ListResourcesRow, error) {
	return r.q(ctx).ListResources(ctx, sqlc.ListResourcesParams{
		UserID:             userID,
		ScAll:              scope.All,
		ScSelf:             scope.Self,
		ScNone:             scope.None,
		ScProjectResources: scope.ProjectResources,
	})
}

// ListEmployeesForCalendar returns resource members active within the window for the calendar.
func (r *CalendarRepository) ListEmployeesForCalendar(
	ctx context.Context,
	start, end date.Date,
) ([]sqlc.ListEmployeesForCalendarRow, error) {
	return r.q(ctx).ListEmployeesForCalendar(ctx, sqlc.ListEmployeesForCalendarParams{
		StartDate: start,
		EndDate:   end,
	})
}

// ListUnavailableRanges returns absence intervals overlapping the window.
func (r *CalendarRepository) ListUnavailableRanges(
	ctx context.Context,
	start, end date.Date,
) ([]sqlc.ListUnavailableRangesRow, error) {
	return r.q(ctx).ListUnavailableRanges(ctx, sqlc.ListUnavailableRangesParams{
		StartDate: start,
		EndDate:   end,
	})
}
