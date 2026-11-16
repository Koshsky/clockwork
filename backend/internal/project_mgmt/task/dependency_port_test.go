package task_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	task "github.com/Koshsky/erp-backend/internal/project_mgmt/task"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	dependency "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency"
	depsql "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type guardedRepository struct {
	task.Repository

	row    sqlc.Task
	writes int
}

func (r *guardedRepository) FindTask(context.Context, int64) (*sqlc.Task, error) {
	row := r.row
	return &row, nil
}
func (r *guardedRepository) UpdateTask(_ context.Context, row sqlc.Task) (*sqlc.Task, error) {
	r.writes++
	r.row = row
	return &row, nil
}

type incomingDependencies struct {
	dependency.Repository

	typ     string
	calls   int
	failure error
}

func (r *incomingDependencies) ListTaskConstraints(
	_ context.Context,
	id int64,
) ([]depsql.ListTaskConstraintsRow, error) {
	r.calls++
	if id != 1 {
		return nil, fmt.Errorf("unexpected task id: %d", id)
	}
	return []depsql.ListTaskConstraintsRow{
		{ID: 3, Type: r.typ, PredTitle: "Подготовка", PredStartDate: "2026-02-01", PredEndDate: "2026-02-10"},
	}, r.failure
}

func TestTaskUpdatesUseRealDependencyConstraintSource(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		typ                  string
		start, end           date.Date
		earlyStart, earlyEnd date.Date
	}{
		{"fs", "2026-02-10", "2026-02-20", "2026-02-09", "2026-02-20"},
		{"ss", "2026-02-01", "2026-02-20", "2026-01-31", "2026-02-20"},
		{"ff", "2026-01-01", "2026-02-10", "2026-01-01", "2026-02-09"},
		{"sf", "2026-01-01", "2026-02-01", "2026-01-01", "2026-01-31"},
	} {
		for _, early := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/early=%t", tc.typ, early), func(t *testing.T) {
				t.Parallel()
				start, end := tc.start, tc.end
				if early {
					start, end = tc.earlyStart, tc.earlyEnd
				}
				checkTaskDependencyBoundary(t, tc.typ, start, end, early)
			})
		}
	}
}

func TestTaskDependencyReadFailureBlocksDateWrite(t *testing.T) {
	t.Parallel()
	failure := errors.New("constraint repository unavailable")
	repo := &guardedRepository{
		row: sqlc.Task{
			ID:        1,
			ProcessID: 11,
			Title:     "Монтаж",
			Status:    task.StatusNotStarted,
			StartDate: "2026-02-10",
			EndDate:   "2026-02-20",
		},
	}
	original := repo.row
	deps := &incomingDependencies{typ: "fs", failure: failure}
	source := dependency.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), deps)
	response, err := task.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo, source).
		UpdateTask(t.Context(), 1, dto.UpdateTaskRequest{StartDate: new(date.Date("2026-02-11"))})
	if !errors.Is(err, failure) || response != nil || repo.writes != 0 || repo.row != original {
		t.Fatalf("constraint read error allowed write: %+v, %v", repo, err)
	}
}

func checkTaskDependencyBoundary(t *testing.T, typ string, start, end date.Date, early bool) {
	t.Helper()
	repo := &guardedRepository{
		row: sqlc.Task{
			ID:        1,
			ProcessID: 11,
			Title:     "Монтаж",
			Status:    task.StatusNotStarted,
			StartDate: "2026-02-10",
			EndDate:   "2026-02-20",
		},
	}
	original := repo.row
	deps := &incomingDependencies{typ: typ}
	var source task.ConstraintSource = dependency.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), deps)

	svc := task.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo, source)
	response, err := svc.UpdateTask(t.Context(), 1, dto.UpdateTaskRequest{StartDate: &start, EndDate: &end})
	if deps.calls != 1 {
		t.Fatalf("dependency port calls=%d", deps.calls)
	}
	if early {
		if !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 ||
			repo.row != original {
			t.Fatalf("incompatible drag persisted task: %+v, %v", repo, err)
		}
		return
	}
	if err != nil || response == nil || repo.writes != 1 || repo.row.StartDate != start ||
		repo.row.EndDate != end {
		t.Fatalf("equal dependency boundary rejected: %+v, %v", response, err)
	}
}
