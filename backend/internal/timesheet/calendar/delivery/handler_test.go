package delivery_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	calendar "github.com/Koshsky/erp-backend/internal/timesheet/calendar"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/delivery"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/calendar/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type calendarAccessRepository struct {
	scope access.ListScope
	user  int64
	calls int
}

func (r *calendarAccessRepository) ListResources(
	_ context.Context,
	user int64,
	scope access.ListScope,
) ([]sqlc.ListResourcesRow, error) {
	r.calls++
	r.user, r.scope = user, scope
	if scope.Self {
		return []sqlc.ListResourcesRow{{ID: 1, OwnerID: user, Title: "Own", Code: "R1"}}, nil
	}
	return []sqlc.ListResourcesRow{
		{ID: 1, OwnerID: 7, Title: "Own", Code: "R1"},
		{ID: 2, OwnerID: 8, Title: "Other", Code: "R2"},
	}, nil
}

func (r *calendarAccessRepository) ListEmployeesForCalendar(
	context.Context,
	date.Date,
	date.Date,
) ([]sqlc.ListEmployeesForCalendarRow, error) {
	r.calls++
	return []sqlc.ListEmployeesForCalendarRow{{ID: 7, ResourceID: 1}, {ID: 8, ResourceID: 2}}, nil
}

func (r *calendarAccessRepository) ListUnavailableRanges(
	context.Context,
	date.Date,
	date.Date,
) ([]sqlc.ListUnavailableRangesRow, error) {
	r.calls++
	return nil, nil
}
func calendarRouter(user *access.UserContext, repo *calendarAccessRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{}, rbac.ProvideAll())
	svc := calendar.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewCalendarHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) {
		if user != nil {
			c.Set(userctx.KeyUser, *user)
		}
	})
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestCalendarHTTPViewScopesAndRangeValidation(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	if err := engine.Publish(
		engine.PublishInput{
			Grants: []engine.RuleGrant{
				{Sub: "calendar-own", Key: "resource/view", Scope: "self"},
				{Sub: "calendar-all", Key: "resource/view", Scope: "all"},
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	own := &access.UserContext{ID: 7, Preset: "calendar-own"}
	all := &access.UserContext{ID: 7, Preset: "calendar-all"}
	none := &access.UserContext{ID: 7}
	admin := &access.UserContext{ID: 7, Admin: true}
	for _, tc := range []struct {
		name, query       string
		user              *access.UserContext
		status, resources int
	}{
		{"own", "start_date=2026-01-01&end_date=2026-01-07", own, 200, 1},
		{"all", "start_date=2026-01-01&end_date=2026-01-07", all, 200, 2},
		{"admin", "start_date=2026-01-01&end_date=2026-01-07", admin, 200, 2},
		{"no access", "start_date=2026-01-01&end_date=2026-01-07", none, 403, 0},
		{"anonymous", "start_date=2026-01-01&end_date=2026-01-07", nil, 401, 0},
		{"missing start", "end_date=2026-01-07", own, 400, 0},
		{"missing end", "start_date=2026-01-01", own, 400, 0},
		{"invalid date", "start_date=bad&end_date=2026-01-07", own, 400, 0},
		{"reversed", "start_date=2026-01-07&end_date=2026-01-01", own, 400, 0},
		{"too wide", "start_date=2024-01-01&end_date=2026-01-01", own, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &calendarAccessRepository{}
			reply := httptest.NewRecorder()
			calendarRouter(
				tc.user,
				repo,
			).ServeHTTP(reply, httptest.NewRequest(http.MethodGet, "/api/v1/timesheet/calendar?"+tc.query, nil))
			if reply.Code != tc.status {
				t.Fatalf("status=%d body=%s", reply.Code, reply.Body.String())
			}
			if tc.status != 200 {
				if repo.calls != 0 {
					t.Fatal("denied/invalid calendar reached repository")
				}
				return
			}
			checkCalendarReply(t, repo, reply, tc.resources, tc.name)
		})
	}
}

func checkCalendarReply(
	t *testing.T,
	repo *calendarAccessRepository,
	reply *httptest.ResponseRecorder,
	count int,
	name string,
) {
	t.Helper()
	var envelope struct {
		Data dto.CalendarPlanning `json:"data"`
	}
	if err := json.Unmarshal(reply.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Data.Resources) != count || repo.user != 7 || repo.calls != 3 {
		t.Fatalf("calendar response/scope changed: %+v", envelope)
	}
	if name == "own" && !repo.scope.Self {
		t.Fatal("owner scope not forwarded")
	}
	if (name == "all" || name == "admin") && !repo.scope.All {
		t.Fatal("all scope not forwarded")
	}
	want := dto.AvailabilityPeriod{
		StartDate:   "2026-01-01",
		EndDate:     "2026-01-07",
		Capacity:    1,
		Unavailable: 0,
		Available:   1,
	}
	for _, resource := range envelope.Data.Resources {
		if len(resource.Periods) != 1 || resource.Periods[0] != want {
			t.Fatalf("daily availability changed: %+v", resource.Periods)
		}
	}
}
