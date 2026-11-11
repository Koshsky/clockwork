//nolint:testpackage // tests the unexported buildPeriods directly
package service

import (
	"context"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

// lsAll/lsOwn/lsNone — compiled scope bundles for tests.
func lsAll() rbac.ListScope  { return rbac.ListScope{All: true} }
func lsOwn() rbac.ListScope  { return rbac.ListScope{Self: true} }
func lsNone() rbac.ListScope { return rbac.ListScope{None: true} }

func dt(s string) time.Time {
	d, err := date.Parse(s)
	if err != nil {
		panic(err)
	}
	return d.Time()
}

func timePtr(s string) *time.Time {
	t := dt(s)
	return &t
}

func period(start, end string, capacity, unavailable, available int) dto.AvailabilityPeriod {
	return dto.AvailabilityPeriod{
		StartDate:   date.From(dt(start)),
		EndDate:     date.From(dt(end)),
		Capacity:    capacity,
		Unavailable: unavailable,
		Available:   available,
	}
}

func TestBuildPeriodsEmpty(t *testing.T) {
	t.Parallel()
	got := buildPeriods(dt("2026-01-01"), dt("2026-01-31"), nil, nil)
	want := []dto.AvailabilityPeriod{period("2026-01-01", "2026-01-31", 0, 0, 0)}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestBuildPeriodsHireAndVacation(t *testing.T) {
	t.Parallel()
	employees := []dto.CalendarMember{
		{UserID: 1, ResourceID: 1, HireDate: timePtr("2025-01-01")},
		{UserID: 2, ResourceID: 1, HireDate: timePtr("2026-06-01")},
	}
	ranges := []dto.UnavailableRange{
		{ResourceID: 1, StartDate: dt("2026-07-20"), EndDate: dt("2026-08-02")},
	}
	got := buildPeriods(dt("2026-01-01"), dt("2026-08-31"), employees, ranges)
	want := []dto.AvailabilityPeriod{
		period("2026-01-01", "2026-05-31", 1, 0, 1),
		period("2026-06-01", "2026-07-19", 2, 0, 2),
		period("2026-07-20", "2026-08-02", 2, 1, 1),
		period("2026-08-03", "2026-08-31", 2, 0, 2),
	}
	if len(got) != len(want) {
		t.Fatalf("got %d periods, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("period %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestBuildPeriodsTerminationAndMerge(t *testing.T) {
	t.Parallel()
	employees := []dto.CalendarMember{
		{UserID: 1, ResourceID: 1, HireDate: timePtr("2024-01-01"), TerminationDate: timePtr("2026-03-15")},
		{UserID: 2, ResourceID: 1, HireDate: timePtr("2024-01-01")},
	}
	got := buildPeriods(dt("2026-01-01"), dt("2026-12-31"), employees, nil)
	want := []dto.AvailabilityPeriod{
		period("2026-01-01", "2026-03-15", 2, 0, 2),
		period("2026-03-16", "2026-12-31", 1, 0, 1),
	}
	if len(got) != len(want) {
		t.Fatalf("got %d periods, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("period %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

// newTestCalendarService builds a CalendarService whose repository is never
// reached by the validation tests (validation runs before any repo call).
func newTestCalendarService() *CalendarService {
	return &CalendarService{tracer: tracing.New(nil)}
}

// TestGetCalendarReversedRangeIsBadRequest checks that an inverted date range
// is a client error (400), not a 500.
func TestGetCalendarReversedRangeIsBadRequest(t *testing.T) {
	t.Parallel()
	_, err := newTestCalendarService().GetCalendar(
		context.Background(),
		0,
		lsOwn(),
		date.From(dt("2026-03-01")),
		date.From(dt("2026-01-01")),
	)
	if err == nil {
		t.Fatal("GetCalendar() succeeded with a reversed range")
	}
	if got := errapi.StatusCode(err); got != http.StatusBadRequest {
		t.Errorf("StatusCode = %d, want 400 (client error, not 500)", got)
	}
}

// TestGetCalendarTooWideRangeIsBadRequest checks the 730-day limit is a client
// error (400), not a 500.
func TestGetCalendarTooWideRangeIsBadRequest(t *testing.T) {
	t.Parallel()
	_, err := newTestCalendarService().GetCalendar(
		context.Background(),
		0,
		lsOwn(),
		date.From(dt("2024-01-01")),
		date.From(dt("2026-06-01")),
	)
	if err == nil {
		t.Fatal("GetCalendar() succeeded with an over-wide range")
	}
	if got := errapi.StatusCode(err); got != http.StatusBadRequest {
		t.Errorf("StatusCode = %d, want 400 (client error, not 500)", got)
	}
}

// stubCalendarRepo is an in-memory CalendarRepository. ListResources applies the
// scoping contract of the SQL query: 'all' returns every resource row, 'own'
// keeps only rows owned by the caller, and an empty zone (no rule / none — the
// engine code for a missing matrix row) also returns every row (reference
// fallback). The received scoping parameters are recorded.
type stubCalendarRepo struct {
	resources []sqlc.ListResourcesRow
	members   []sqlc.ListEmployeesForCalendarRow
	ranges    []sqlc.ListUnavailableRangesRow

	listResourcesCalls int
	lastUserID         int64
	lastViewScope      rbac.ListScope
}

func (s *stubCalendarRepo) ListResources(
	_ context.Context,
	userID int64,
	scope rbac.ListScope,
) ([]sqlc.ListResourcesRow, error) {
	s.listResourcesCalls++
	s.lastUserID = userID
	s.lastViewScope = scope
	out := make([]sqlc.ListResourcesRow, 0, len(s.resources))
	for _, r := range s.resources {
		if scope.Self && r.OwnerID != userID {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *stubCalendarRepo) ListEmployeesForCalendar(
	_ context.Context,
	_, _ date.Date,
) ([]sqlc.ListEmployeesForCalendarRow, error) {
	return s.members, nil
}

func (s *stubCalendarRepo) ListUnavailableRanges(
	_ context.Context,
	_, _ date.Date,
) ([]sqlc.ListUnavailableRangesRow, error) {
	return s.ranges, nil
}

// newScopedCalendarService builds a CalendarService over the stub repository.
func newScopedCalendarService(repo CalendarRepository) *CalendarService {
	return &CalendarService{
		logger:     slog.New(slog.DiscardHandler),
		repository: repo,
		tracer:     tracing.New(nil),
	}
}

// calendarWindow is the date range shared by the view-scope tests.
func calendarWindow() (date.Date, date.Date) {
	return date.From(dt("2026-01-01")), date.From(dt("2026-01-31"))
}

// TestGetCalendarResourceScopeOwn checks that an 'own' resource view zone
// limits the returned resources to the caller's own rows and passes the scope
// through to the repository.
func TestGetCalendarResourceScopeOwn(t *testing.T) {
	t.Parallel()
	repo := &stubCalendarRepo{
		resources: []sqlc.ListResourcesRow{
			{ID: 1, Title: "Mounter", Code: "M", OwnerID: 7},
			{ID: 2, Title: "Engineer", Code: "E", OwnerID: 9},
		},
	}
	start, end := calendarWindow()

	got, err := newScopedCalendarService(repo).GetCalendar(context.Background(), 7, lsOwn(), start, end)
	if err != nil {
		t.Fatalf("GetCalendar() error = %v", err)
	}
	if len(got.Resources) != 1 || got.Resources[0].ResourceID != 1 {
		t.Fatalf("resources = %+v, want only the owned resource 1", got.Resources)
	}
	if repo.lastUserID != 7 || !repo.lastViewScope.Self {
		t.Errorf("resource scope call = (%d, %v), want (7, self)", repo.lastUserID, repo.lastViewScope)
	}
}

// TestGetCalendarNoResourceScopeRule checks the reference fallback: a caller
// with a view right but no resolved resource zone (empty code — no rule /
// none) still gets every resource row, otherwise the calendar would render
// nothing.
func TestGetCalendarNoResourceScopeRule(t *testing.T) {
	t.Parallel()
	repo := &stubCalendarRepo{
		resources: []sqlc.ListResourcesRow{
			{ID: 1, Title: "Mounter", Code: "M", OwnerID: 7},
			{ID: 2, Title: "Engineer", Code: "E", OwnerID: 9},
		},
	}
	start, end := calendarWindow()

	got, err := newScopedCalendarService(repo).GetCalendar(context.Background(), 7, lsNone(), start, end)
	if err != nil {
		t.Fatalf("GetCalendar() error = %v", err)
	}
	if len(got.Resources) != 2 {
		t.Fatalf("resources = %+v, want both rows (empty zone = include-all)", got.Resources)
	}
	if !repo.lastViewScope.None {
		t.Errorf("resource scope call = %v, want none (no resource view rule)", repo.lastViewScope)
	}
}

// TestGetCalendarResourceScopeAll checks that an 'all' resource view zone
// returns every resource row.
func TestGetCalendarResourceScopeAll(t *testing.T) {
	t.Parallel()
	repo := &stubCalendarRepo{
		resources: []sqlc.ListResourcesRow{
			{ID: 1, Title: "Mounter", Code: "M", OwnerID: 7},
			{ID: 2, Title: "Engineer", Code: "E", OwnerID: 9},
		},
	}
	start, end := calendarWindow()

	got, err := newScopedCalendarService(repo).GetCalendar(context.Background(), 7, lsAll(), start, end)
	if err != nil {
		t.Fatalf("GetCalendar() error = %v", err)
	}
	if len(got.Resources) != 2 {
		t.Fatalf("resources = %+v, want both resources", got.Resources)
	}
	if got.Resources[0].ResourceID != 1 || got.Resources[1].ResourceID != 2 {
		t.Errorf("resource order = %d, %d; want 1, 2", got.Resources[0].ResourceID, got.Resources[1].ResourceID)
	}
	if !repo.lastViewScope.All {
		t.Errorf("resource scope call = %v, want all", repo.lastViewScope)
	}
}

// TestGetCalendarEmptyResources checks that an empty resource result stays
// consistent: a non-nil empty array, one period for the whole window and no
// interval data leaking into the answer.
func TestGetCalendarEmptyResources(t *testing.T) {
	t.Parallel()
	repo := &stubCalendarRepo{
		members: []sqlc.ListEmployeesForCalendarRow{{ID: 5, ResourceID: 1}},
		ranges: []sqlc.ListUnavailableRangesRow{
			{ResourceID: 1, StartDate: date.From(dt("2026-01-10")), EndDate: date.From(dt("2026-01-12"))},
		},
	}
	start, end := calendarWindow()

	got, err := newScopedCalendarService(repo).GetCalendar(context.Background(), 7, lsOwn(), start, end)
	if err != nil {
		t.Fatalf("GetCalendar() error = %v", err)
	}
	if got == nil || got.Resources == nil {
		t.Fatalf("resources = %v, want a non-nil empty slice", got)
	}
	if len(got.Resources) != 0 {
		t.Fatalf("resources = %+v, want an empty slice", got.Resources)
	}
	if repo.listResourcesCalls != 1 {
		t.Errorf("ListResources calls = %d, want 1", repo.listResourcesCalls)
	}
	if !repo.lastViewScope.Self || repo.lastUserID != 7 {
		t.Errorf("resource scope call = (%d, %v), want (7, self)", repo.lastUserID, repo.lastViewScope)
	}
}
