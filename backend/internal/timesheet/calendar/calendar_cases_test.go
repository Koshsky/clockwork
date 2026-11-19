//nolint:testpackage // Exercises the sweep against explicit intervals and reuses the existing calendar fixtures.
package calendar

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/diagnostics"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

func TestCalendarOverlapAdjacencyAndInclusiveEdges(t *testing.T) {
	t.Parallel()
	two := []dto.CalendarMember{{UserID: 1}, {UserID: 2}}
	for _, tc := range []struct {
		name    string
		members []dto.CalendarMember
		ranges  []dto.UnavailableRange
		want    []dto.AvailabilityPeriod
	}{
		{"overlap across two employees", two, []dto.UnavailableRange{{StartDate: dt("2026-01-02"), EndDate: dt("2026-01-04")}, {StartDate: dt("2026-01-03"), EndDate: dt("2026-01-05")}}, []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-01", 2, 0, 2), period("2026-01-02", "2026-01-02", 2, 1, 1), period("2026-01-03", "2026-01-04", 2, 2, 0), period("2026-01-05", "2026-01-05", 2, 1, 1), period("2026-01-06", "2026-01-07", 2, 0, 2)}},
		{"adjacent absences merge", two, []dto.UnavailableRange{{StartDate: dt("2026-01-02"), EndDate: dt("2026-01-03")}, {StartDate: dt("2026-01-04"), EndDate: dt("2026-01-05")}}, []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-01", 2, 0, 2), period("2026-01-02", "2026-01-05", 2, 1, 1), period("2026-01-06", "2026-01-07", 2, 0, 2)}},
		{"absence clipped at request start", two, []dto.UnavailableRange{{StartDate: dt("2025-12-30"), EndDate: dt("2026-01-02")}}, []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-02", 2, 1, 1), period("2026-01-03", "2026-01-07", 2, 0, 2)}},
		{"staff replacement has no capacity seam", []dto.CalendarMember{{UserID: 1, TerminationDate: timePtr("2026-01-03")}, {UserID: 2, HireDate: timePtr("2026-01-04")}}, nil, []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-07", 1, 0, 1)}},
		{"exhausted throughout request", two, []dto.UnavailableRange{{StartDate: dt("2025-12-30"), EndDate: dt("2026-01-09")}, {StartDate: dt("2025-12-30"), EndDate: dt("2026-01-09")}}, []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-07", 2, 2, 0)}},
		{"hire termination and absence end are inclusive", []dto.CalendarMember{{UserID: 1, HireDate: timePtr("2026-01-03"), TerminationDate: timePtr("2026-01-04")}, {UserID: 2, HireDate: timePtr("2026-01-05")}}, []dto.UnavailableRange{{StartDate: dt("2026-01-03"), EndDate: dt("2026-01-04")}}, []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-02", 0, 0, 0), period("2026-01-03", "2026-01-04", 1, 1, 0), period("2026-01-05", "2026-01-07", 1, 0, 1)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := buildPeriods(dt("2026-01-01"), dt("2026-01-07"), tc.members, tc.ranges)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("availability intervals changed: got=%+v want=%+v", got, tc.want)
			}
		})
	}
}

type calendarReadRepository struct {
	stubCalendarRepo

	calls   []string
	windows [][2]date.Date
	failAt  string
	failure error
}

func (r *calendarReadRepository) ListResources(
	ctx context.Context,
	user int64,
	scope access.ListScope,
) ([]sqlc.ListResourcesRow, error) {
	r.calls = append(r.calls, "resources")
	if r.failAt == "resources" {
		return nil, r.failure
	}
	return r.stubCalendarRepo.ListResources(ctx, user, scope)
}

func (r *calendarReadRepository) ListEmployeesForCalendar(
	_ context.Context,
	start, end date.Date,
) ([]sqlc.ListEmployeesForCalendarRow, error) {
	r.calls = append(r.calls, "members")
	r.windows = append(r.windows, [2]date.Date{start, end})
	if r.failAt == "members" {
		return nil, r.failure
	}
	return r.members, nil
}

func (r *calendarReadRepository) ListUnavailableRanges(
	_ context.Context,
	start, end date.Date,
) ([]sqlc.ListUnavailableRangesRow, error) {
	r.calls = append(r.calls, "ranges")
	r.windows = append(r.windows, [2]date.Date{start, end})
	if r.failAt == "ranges" {
		return nil, r.failure
	}
	return r.ranges, nil
}

func TestCalendarMultipleResourcesAndNullableEmployment(t *testing.T) {
	t.Parallel()
	fixture := stubCalendarRepo{
		resources: []sqlc.ListResourcesRow{
			{ID: 1, OwnerID: 7, Title: "Ресурс <one>", Code: "R1"},
			{ID: 2, OwnerID: 7, Title: "Two", Code: "R2"},
		},
		members: []sqlc.ListEmployeesForCalendarRow{
			{ID: 7, ResourceID: 1},
			{ID: 8, ResourceID: 2},
			{
				ID:              9,
				ResourceID:      2,
				HireDate:        pgtype.Date{Time: dt("2026-01-03"), Valid: true},
				TerminationDate: pgtype.Date{Time: dt("2026-01-05"), Valid: true},
			},
			{ID: 99, ResourceID: 99},
		},
		ranges: []sqlc.ListUnavailableRangesRow{
			{ResourceID: 1, StartDate: "2026-01-02", EndDate: "2026-01-03"},
			{ResourceID: 2, StartDate: "2026-01-04", EndDate: "2026-01-04"},
			{ResourceID: 99, StartDate: "2026-01-01", EndDate: "2026-01-07"},
		},
	}
	repo := &calendarReadRepository{stubCalendarRepo: fixture}
	result, err := NewService(
		slog.New(slog.DiscardHandler),
		tracing.New(nil),
		repo,
	).GetCalendar(t.Context(), 7, lsOwn(), "2026-01-01", "2026-01-07")
	want := &dto.CalendarPlanning{Resources: []dto.ResourceCalendar{
		{
			ResourceID: 1,
			Title:      "Ресурс <one>",
			Code:       "R1",
			Periods: []dto.AvailabilityPeriod{
				period("2026-01-01", "2026-01-01", 1, 0, 1),
				period("2026-01-02", "2026-01-03", 1, 1, 0),
				period("2026-01-04", "2026-01-07", 1, 0, 1),
			},
		},
		{
			ResourceID: 2,
			Title:      "Two",
			Code:       "R2",
			Periods: []dto.AvailabilityPeriod{
				period("2026-01-01", "2026-01-02", 1, 0, 1),
				period("2026-01-03", "2026-01-03", 2, 0, 2),
				period("2026-01-04", "2026-01-04", 2, 1, 1),
				period("2026-01-05", "2026-01-05", 2, 0, 2),
				period("2026-01-06", "2026-01-07", 1, 0, 1),
			},
		},
	}}
	if err != nil || !reflect.DeepEqual(result, want) {
		t.Fatalf("calendar mapping/resource isolation changed: %+v, %v", result, err)
	}
	windows := [][2]date.Date{{"2026-01-01", "2026-01-07"}, {"2026-01-01", "2026-01-07"}}
	if repo.lastUserID != 7 || !repo.lastViewScope.Self || !reflect.DeepEqual(repo.windows, windows) {
		t.Fatalf("calendar scope/window forwarding changed: %+v", repo)
	}
}

func TestCalendarExactInclusiveRangeLimit(t *testing.T) {
	t.Parallel()
	start := date.Date("2024-02-29")
	for _, tc := range []struct {
		name    string
		end     date.Date
		invalid bool
	}{
		{"one day", start, false}, {"730 included days", date.From(start.Time().AddDate(0, 0, 729)), false}, {"731 included days", date.From(start.Time().AddDate(0, 0, 730)), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &calendarReadRepository{}
			result, err := NewService(
				slog.New(slog.DiscardHandler),
				tracing.New(nil),
				repo,
			).GetCalendar(t.Context(), 7, lsAll(), start, tc.end)
			if tc.invalid {
				if errorsapi.StatusCode(err) != http.StatusBadRequest || result != nil || len(repo.calls) != 0 {
					t.Fatalf("wide range queried repository: %+v, %v", repo, err)
				}
				return
			}
			if err != nil || result == nil || result.Resources == nil || len(result.Resources) != 0 ||
				!reflect.DeepEqual(repo.calls, []string{"resources", "members", "ranges"}) {
				t.Fatalf("valid empty calendar changed: %+v, %v", result, err)
			}
		})
	}
}

func TestCalendarReadFailuresStopSubsequentQueries(t *testing.T) {
	t.Parallel()
	for _, step := range []string{"resources", "members", "ranges"} {
		t.Run(step, func(t *testing.T) {
			t.Parallel()
			failure := errors.New("calendar repository unavailable")
			counts := diagnostics.NewOutcomes()
			ctx := diagnostics.WithOutcomes(t.Context(), counts)
			repo := &calendarReadRepository{failAt: step, failure: failure}
			result, err := NewService(
				slog.New(slog.DiscardHandler),
				tracing.New(nil),
				repo,
			).GetCalendar(ctx, 7, lsAll(), "2026-01-01", "2026-01-07")
			if !errors.Is(err, failure) || result != nil || repo.calls[len(repo.calls)-1] != step {
				t.Fatalf("calendar error/query ordering changed: %+v, %v", repo, err)
			}
			if got := counts.Snapshot(); len(got) != 1 || got[0].Stage != diagnostics.Calendar ||
				got[0].Outcome != diagnostics.Failed {
				t.Fatal("calendar failure lost its controlled outcome")
			}
		})
	}
}
