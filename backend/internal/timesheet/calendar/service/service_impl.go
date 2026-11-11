package service

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/dto"
	repo "github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository/sqlc"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

// maxCalendarRange is the maximum calendar range width per request (in days).
const (
	maxCalendarRange = 730
	hoursPerDay      = 24
)

type CalendarService struct {
	logger     *slog.Logger
	repository CalendarRepository
	tracer     *tracingpkg.Tracer
}

// NewCalendarService builds the CalendarService service.
func NewCalendarService(logger *slog.Logger, tracer *tracingpkg.Tracer, r *repo.CalendarRepository) *CalendarService {
	return &CalendarService{
		logger:     logger.With("component", "calendar_service"),
		repository: r,
		tracer:     tracer,
	}
}

// GetCalendar returns resource availability as ranges (constant-availability
// segments): capacity, unavailable and available. Complexity O((M+S) log(M+S))
// depends on resource members and state intervals, not the number of days.
// Resources are scoped by the caller's resource view zone (userID/scope),
// so a process owner only sees capacity curves of its own resources.
func (s *CalendarService) GetCalendar(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	start, end date.Date,
) (*dto.CalendarPlanning, error) {
	ctx, finish := s.tracer.Start(ctx, "calendar.GetCalendar")
	defer finish(nil)

	startT, endT := start.Time(), end.Time()
	if endT.Before(startT) {
		return nil, errors.BadRequest("end_date must be greater than or equal to start_date")
	}
	if int(endT.Sub(startT).Hours()/hoursPerDay) > maxCalendarRange-1 {
		return nil, errors.BadRequestM(messages.M("validator.max_days", maxCalendarRange))
	}

	resourceRows, err := s.repository.ListResources(ctx, userID, scope)
	if err != nil {
		return nil, err
	}
	memberRows, err := s.repository.ListEmployeesForCalendar(ctx, start, end)
	if err != nil {
		return nil, err
	}
	rangeRows, err := s.repository.ListUnavailableRanges(ctx, start, end)
	if err != nil {
		return nil, err
	}

	resources := make([]dto.ResourceInfo, len(resourceRows))
	for i, row := range resourceRows {
		resources[i] = toResourceInfo(row)
	}
	members := make([]dto.CalendarMember, len(memberRows))
	for i, row := range memberRows {
		members[i] = toCalendarMember(row)
	}
	ranges := make([]dto.UnavailableRange, len(rangeRows))
	for i, row := range rangeRows {
		ranges[i] = toUnavailableRange(row)
	}

	membersByResource := groupMembers(members)
	rangesByResource := groupRanges(ranges)

	planning := &dto.CalendarPlanning{
		Resources: make([]dto.ResourceCalendar, 0, len(resources)),
	}
	for _, resource := range resources {
		periods := buildPeriods(
			startT,
			endT,
			membersByResource[resource.ID],
			rangesByResource[resource.ID],
		)
		planning.Resources = append(planning.Resources, dto.ResourceCalendar{
			ResourceID: resource.ID,
			Title:      resource.Title,
			Code:       resource.Code,
			Periods:    periods,
		})
	}

	return planning, nil
}

// toResourceInfo converts a resource row for the calendar view.
func toResourceInfo(row sqlc.ListResourcesRow) dto.ResourceInfo {
	return dto.ResourceInfo{
		ID:      row.ID,
		Title:   row.Title,
		Code:    row.Code,
		OwnerID: &row.OwnerID,
	}
}

// toCalendarMember converts a resource member row (work interval for the calendar).
func toCalendarMember(row sqlc.ListEmployeesForCalendarRow) dto.CalendarMember {
	return dto.CalendarMember{
		UserID:          row.ID,
		ResourceID:      row.ResourceID,
		HireDate:        fromDate(row.HireDate),
		TerminationDate: fromDate(row.TerminationDate),
	}
}

// toUnavailableRange converts an absence interval row.
func toUnavailableRange(row sqlc.ListUnavailableRangesRow) dto.UnavailableRange {
	return dto.UnavailableRange{
		ResourceID: row.ResourceID,
		StartDate:  row.StartDate.Time(),
		EndDate:    row.EndDate.Time(),
	}
}

// fromDate unwraps a nullable date (pgtype.Date) into [time.Time].
func fromDate(v pgtype.Date) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}

func groupMembers(members []dto.CalendarMember) map[int64][]dto.CalendarMember {
	result := make(map[int64][]dto.CalendarMember, len(members))
	for _, member := range members {
		result[member.ResourceID] = append(result[member.ResourceID], member)
	}
	return result
}

func groupRanges(ranges []dto.UnavailableRange) map[int64][]dto.UnavailableRange {
	result := make(map[int64][]dto.UnavailableRange, len(ranges))
	for _, r := range ranges {
		result[r.ResourceID] = append(result[r.ResourceID], r)
	}
	return result
}

// availabilityEvent is a change in the number of active/unavailable on a day.
type availabilityEvent struct {
	active int
	absent int
}

// buildPeriods computes [start, end] constant-availability segments via an event
// sweep: segment bounds are hire/termination dates and absence interval edges.
func buildPeriods(
	start, end time.Time,
	members []dto.CalendarMember,
	ranges []dto.UnavailableRange,
) []dto.AvailabilityPeriod {
	active := countActiveAt(start, members)
	absent := countAbsentAt(start, ranges)

	events := make(map[time.Time]availabilityEvent)
	addEvent := func(day time.Time, deltaActive, deltaAbsent int) {
		if day.After(start) && !day.After(end) {
			event := events[day]
			event.active += deltaActive
			event.absent += deltaAbsent
			events[day] = event
		}
	}
	for _, member := range members {
		if member.HireDate != nil {
			addEvent(*member.HireDate, 1, 0)
		}
		if member.TerminationDate != nil {
			addEvent(member.TerminationDate.AddDate(0, 0, 1), -1, 0)
		}
	}
	for _, r := range ranges {
		addEvent(r.StartDate, 0, 1)
		addEvent(r.EndDate.AddDate(0, 0, 1), 0, -1)
	}

	days := make([]time.Time, 0, len(events))
	for day := range events {
		days = append(days, day)
	}
	slices.SortFunc(days, func(a, b time.Time) int { return a.Compare(b) })

	periods := make([]dto.AvailabilityPeriod, 0, len(days)+1)
	prev := start
	appendPeriod := func(segStart, segEnd time.Time) {
		if segStart.After(segEnd) {
			return
		}
		if n := len(periods); n > 0 &&
			periods[n-1].Capacity == active && periods[n-1].Unavailable == absent {
			periods[n-1].EndDate = date.From(segEnd)
			return
		}
		periods = append(periods, dto.AvailabilityPeriod{
			StartDate:   date.From(segStart),
			EndDate:     date.From(segEnd),
			Capacity:    active,
			Unavailable: absent,
			Available:   active - absent,
		})
	}

	for _, day := range days {
		appendPeriod(prev, day.AddDate(0, 0, -1))
		event := events[day]
		active += event.active
		absent += event.absent
		prev = day
	}
	appendPeriod(prev, end)

	return periods
}

// countActiveAt counts members active on day.
func countActiveAt(day time.Time, members []dto.CalendarMember) int {
	count := 0
	for _, member := range members {
		if (member.HireDate == nil || !member.HireDate.After(day)) &&
			(member.TerminationDate == nil || !member.TerminationDate.Before(day)) {
			count++
		}
	}
	return count
}

// countAbsentAt counts members absent on day.
func countAbsentAt(day time.Time, ranges []dto.UnavailableRange) int {
	count := 0
	for _, r := range ranges {
		if !r.StartDate.After(day) && !r.EndDate.Before(day) {
			count++
		}
	}
	return count
}
