package service //nolint:testpackage // Verifies the service with an injected repository and dependency checker.

import (
	"context"
	"errors"
	"testing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/domain"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
)

type updateRepository struct {
	TaskRepository

	task    sqlc.Task
	updates int
}

func (r *updateRepository) FindTask(context.Context, int64) (*sqlc.Task, error) {
	task := r.task
	return &task, nil
}

func (r *updateRepository) UpdateTask(_ context.Context, task sqlc.Task) (*sqlc.Task, error) {
	r.task = task
	r.updates++
	return &task, nil
}

type updateConstraints struct {
	t     *testing.T
	want  sqlc.Task
	calls int
	err   error
}

func (c *updateConstraints) CheckTaskDates(
	_ context.Context,
	id int64,
	title string,
	start, end date.Date,
) error {
	c.t.Helper()
	c.calls++
	if id != c.want.ID || title != c.want.Title || start != c.want.StartDate || end != c.want.EndDate {
		c.t.Fatalf("checker received wrong task: %d %q %s %s", id, title, start, end)
	}
	return c.err
}

func TestUpdateTaskDateConstraints(t *testing.T) {
	t.Parallel()
	start, end := date.Date("2026-11-02"), date.Date("2026-11-29")
	title := "Updated title"
	dependencyErr := errors.New("dependency rejected dates")
	for _, tc := range []struct {
		name       string
		request    dto.UpdateTaskRequest
		noChecker  bool
		rejected   bool
		wantChecks int
	}{
		{name: "empty patch"},
		{name: "title only", request: dto.UpdateTaskRequest{Title: &title}},
		{name: "start only", request: dto.UpdateTaskRequest{StartDate: &start}, wantChecks: 1},
		{name: "end only", request: dto.UpdateTaskRequest{EndDate: &end}, wantChecks: 1},
		{
			name: "both dates and title", wantChecks: 1,
			request: dto.UpdateTaskRequest{StartDate: &start, EndDate: &end, Title: &title},
		},
		{name: "without checker", request: dto.UpdateTaskRequest{StartDate: &start}, noChecker: true},
		{name: "rejected start", request: dto.UpdateTaskRequest{StartDate: &start}, rejected: true, wantChecks: 1},
		{name: "rejected end", request: dto.UpdateTaskRequest{EndDate: &end}, rejected: true, wantChecks: 1},
		{
			name: "rejected both dates", rejected: true, wantChecks: 1,
			request: dto.UpdateTaskRequest{StartDate: &start, EndDate: &end},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repository := &updateRepository{task: sqlc.Task{
				ID: 7, ProcessID: 10, Title: "Existing title", Status: domain.StatusNotStarted,
				StartDate: "2026-11-01", EndDate: "2026-11-30",
			}}
			want := repository.task
			if tc.request.StartDate != nil {
				want.StartDate = *tc.request.StartDate
			}
			if tc.request.EndDate != nil {
				want.EndDate = *tc.request.EndDate
			}
			if tc.request.Title != nil {
				want.Title = *tc.request.Title
			}
			checker := &updateConstraints{t: t, want: want}
			if tc.rejected {
				checker.err = dependencyErr
			}
			service := &TaskService{
				repository: repository, tracer: tracing.New(nil), mapper: &TaskMapper{},
				validator: &TaskValidator{}, deps: checker,
			}
			if tc.noChecker {
				service.deps = nil
			}
			got, err := service.UpdateTask(t.Context(), want.ID, tc.request)
			if checker.calls != tc.wantChecks {
				t.Fatalf("dependency checks: got %d, want %d", checker.calls, tc.wantChecks)
			}
			assertTaskUpdate(t, repository, got, err, want, tc.rejected, dependencyErr)
		})
	}
}

func assertTaskUpdate(
	t *testing.T,
	repository *updateRepository,
	got *dto.TaskResponse,
	err error,
	want sqlc.Task,
	rejected bool,
	dependencyErr error,
) {
	t.Helper()
	if rejected {
		if !errors.Is(err, dependencyErr) || got != nil || repository.updates != 0 {
			t.Fatalf("rejected update was not preserved: response=%v err=%v writes=%d", got, err, repository.updates)
		}
		if repository.task.StartDate != "2026-11-01" || repository.task.EndDate != "2026-11-30" {
			t.Fatal("rejected update changed stored dates")
		}
		return
	}
	if err != nil || got == nil {
		t.Fatalf("UpdateTask: response=%v err=%v", got, err)
	}
	if repository.updates != 1 || repository.task != want {
		t.Fatalf("saved task differs: writes=%d task=%+v want=%+v", repository.updates, repository.task, want)
	}
	if got.ID != want.ID || got.Title != want.Title || got.StartDate != want.StartDate || got.EndDate != want.EndDate {
		t.Fatalf("response differs from saved task: %+v", got)
	}
}
