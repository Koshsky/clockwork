package taskdependency_test

import (
	"context"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	dependency "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type dependencyRepository struct {
	link          sqlc.ValidateLinkRow
	dep           sqlc.TaskDependency
	constraints   []sqlc.ListTaskConstraintsRow
	dates         sqlc.FindTaskDatesRow
	rows          []sqlc.TaskDependency
	exists, cycle bool
	failures      map[string]error
	calls         []string
	writes        int
}

func newDependencyRepository() *dependencyRepository {
	return &dependencyRepository{
		link: sqlc.ValidateLinkRow{
			TaskID:        1,
			TaskTitle:     "Монтаж",
			TaskStartDate: "2026-02-10",
			TaskEndDate:   "2026-02-20",
			TaskProcessID: 11,
			TaskIsTop:     true,
			PredID:        2,
			PredTitle:     "Подготовка",
			PredStartDate: "2026-02-01",
			PredEndDate:   "2026-02-10",
			PredProcessID: 11,
			PredIsTop:     true,
		},
		dep:      sqlc.TaskDependency{ID: 3, TaskID: 1, DependsOnTaskID: 2, Type: "fs"},
		dates:    sqlc.FindTaskDatesRow{StartDate: "2026-02-05", EndDate: "2026-02-20"},
		failures: map[string]error{},
	}
}
func newDependencyService(repo *dependencyRepository) *dependency.Service {
	return dependency.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
}
func (r *dependencyRepository) call(name string) error {
	r.calls = append(r.calls, name)
	return r.failures[name]
}
func (r *dependencyRepository) ValidateLink(context.Context, int64, int64) (sqlc.ValidateLinkRow, error) {
	return r.link, r.call("link")
}
func (r *dependencyRepository) DependencyExists(context.Context, int64, int64) (bool, error) {
	return r.exists, r.call("exists")
}
func (r *dependencyRepository) DependencyCycle(context.Context, int64, int64) (bool, error) {
	return r.cycle, r.call("cycle")
}

func (r *dependencyRepository) CreateDependency(
	_ context.Context,
	task, pred int64,
	typ string,
) (*sqlc.TaskDependency, error) {
	r.writes++
	return &sqlc.TaskDependency{ID: 3, TaskID: task, DependsOnTaskID: pred, Type: typ}, r.call("create")
}
func (r *dependencyRepository) FindDependency(context.Context, int64) (*sqlc.TaskDependency, error) {
	d := r.dep
	return &d, r.call("find")
}

func (r *dependencyRepository) UpdateDependencyType(
	_ context.Context,
	id int64,
	typ string,
) (*sqlc.TaskDependency, error) {
	r.writes++
	d := r.dep
	d.ID = id
	d.Type = typ
	return &d, r.call("update")
}
func (r *dependencyRepository) DeleteDependency(context.Context, int64) error {
	r.writes++
	return r.call("delete")
}
func (r *dependencyRepository) ListDependenciesByTask(context.Context, int64) ([]sqlc.TaskDependency, error) {
	return r.rows, r.call("list")
}
func (r *dependencyRepository) ListTaskConstraints(context.Context, int64) ([]sqlc.ListTaskConstraintsRow, error) {
	return r.constraints, r.call("constraints")
}
func (r *dependencyRepository) FindTaskDates(context.Context, int64) (sqlc.FindTaskDatesRow, error) {
	return r.dates, r.call("dates")
}

func TestDependencyCreateRejectsInvalidGraph(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name       string
		task, pred int64
		typ        string
		change     func(*dependencyRepository)
	}{
		{"self link", 1, 1, "fs", func(*dependencyRepository) {}},
		{"zero successor", 0, 2, "fs", func(*dependencyRepository) {}},
		{"negative predecessor", 1, -2, "fs", func(*dependencyRepository) {}},
		{"unknown type", 1, 2, "FS", func(*dependencyRepository) {}},
		{"missing predecessor", 1, 2, "fs", func(r *dependencyRepository) { r.link.PredID = 0 }},
		{"different processes", 1, 2, "fs", func(r *dependencyRepository) { r.link.PredProcessID = 22 }},
		{"successor is subtask", 1, 2, "fs", func(r *dependencyRepository) { r.link.TaskIsTop = false }},
		{"predecessor is subtask", 1, 2, "fs", func(r *dependencyRepository) { r.link.PredIsTop = false }},
		{"duplicate", 1, 2, "fs", func(r *dependencyRepository) { r.exists = true }},
		{"cycle", 1, 2, "fs", func(r *dependencyRepository) { r.cycle = true }},
		{"violated current dates", 1, 2, "fs", func(r *dependencyRepository) { r.link.TaskStartDate = "2026-02-09" }},
		{"missing successor", 1, 2, "fs", func(r *dependencyRepository) { r.failures["link"] = errorsapi.ErrNotFound }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := newDependencyRepository()
			tc.change(repo)
			response, err := newDependencyService(
				repo,
			).CreateDependency(t.Context(), tc.task, dto.CreateDependencyRequest{DependsOnTaskID: tc.pred, Type: tc.typ})
			if !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 {
				t.Fatalf("invalid graph reached write: %+v, %v", response, err)
			}
		})
	}
}

func TestDependencyCreateInclusiveDates(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		typ        string
		start, end date.Date
	}{
		{"fs", "2026-02-10", "2026-02-20"}, {"ss", "2026-02-01", "2026-02-20"},
		{"ff", "2026-01-01", "2026-02-10"}, {"sf", "2026-01-01", "2026-02-01"},
	} {
		t.Run(tc.typ, func(t *testing.T) {
			t.Parallel()
			repo := newDependencyRepository()
			repo.link.TaskStartDate, repo.link.TaskEndDate = tc.start, tc.end
			response, err := newDependencyService(
				repo,
			).CreateDependency(t.Context(), 1, dto.CreateDependencyRequest{DependsOnTaskID: 2, Type: tc.typ})
			want := &dto.DependencyResponse{ID: 3, TaskID: 1, DependsOnTaskID: 2, Type: tc.typ}
			if err != nil || !reflect.DeepEqual(response, want) || repo.writes != 1 {
				t.Fatalf("inclusive boundary rejected or mapping changed: %+v, %v", response, err)
			}
		})
	}
}

func TestDependencyCreateFailuresPropagate(t *testing.T) {
	t.Parallel()
	for _, step := range []string{"link", "exists", "cycle", "create"} {
		t.Run(step, func(t *testing.T) {
			t.Parallel()
			repo := newDependencyRepository()
			failure := errors.New("repository unavailable")
			repo.failures[step] = failure
			response, err := newDependencyService(
				repo,
			).CreateDependency(t.Context(), 1, dto.CreateDependencyRequest{DependsOnTaskID: 2, Type: "fs"})
			wantWrites := 0
			if step == "create" {
				wantWrites = 1
			}
			if !errors.Is(err, failure) || response != nil || repo.writes != wantWrites {
				t.Fatalf("failure not propagated before write: %+v, %v", repo, err)
			}
		})
	}
}

func TestDependencyTypeChangeChecksAllIncomingLinks(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		change func(*dependencyRepository)
		typ    string
		want   error
		writes int
	}{
		{"same type skips date queries", func(*dependencyRepository) {}, "fs", nil, 1},
		{"substitute target type at equality", func(*dependencyRepository) {}, "ss", nil, 1},
		{"new type violates target", func(r *dependencyRepository) { r.constraints[0].PredStartDate = "2026-02-06" }, "ss", errorsapi.ErrValidation, 0},
		{"other link remains binding", func(r *dependencyRepository) {
			r.constraints = append(r.constraints, sqlc.ListTaskConstraintsRow{ID: 4, Type: "ff", PredEndDate: "2026-02-21"})
		}, "ss", errorsapi.ErrValidation, 0},
		{"foreign successor", func(r *dependencyRepository) { r.dep.TaskID = 9 }, "ss", errorsapi.ErrValidation, 0},
		{"missing link", func(r *dependencyRepository) { r.failures["find"] = errorsapi.ErrNotFound }, "ss", errorsapi.ErrNotFound, 0},
		{"missing task dates", func(r *dependencyRepository) { r.failures["dates"] = errorsapi.ErrNotFound }, "ss", errorsapi.ErrNotFound, 0},
		{"invalid type", func(*dependencyRepository) {}, "FS", errorsapi.ErrValidation, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := newDependencyRepository()
			repo.constraints = []sqlc.ListTaskConstraintsRow{
				{ID: 3, Type: "fs", PredTitle: "Подготовка", PredStartDate: "2026-02-05", PredEndDate: "2026-02-10"},
			}
			tc.change(repo)
			response, err := newDependencyService(
				repo,
			).UpdateDependencyType(t.Context(), 1, 3, dto.UpdateDependencyRequest{Type: tc.typ})
			if !errors.Is(err, tc.want) || repo.writes != tc.writes {
				t.Fatalf("type change validation changed: %+v, %v", repo, err)
			}
			if tc.want == nil &&
				(response == nil || response.TaskID != 1 || response.DependsOnTaskID != 2 || response.Type != tc.typ) {
				t.Fatalf("type update changed endpoints: %+v", response)
			}
			if tc.name == "same type skips date queries" && !reflect.DeepEqual(repo.calls, []string{"find", "update"}) {
				t.Fatalf("same type queried dates: %v", repo.calls)
			}
			if repo.constraints[0].Type != "fs" {
				t.Fatal("temporary type substitution mutated stored constraint")
			}
		})
	}
}

func TestDependencyUpdateFailuresPropagate(t *testing.T) {
	t.Parallel()
	for _, step := range []string{"find", "constraints", "dates", "update"} {
		t.Run(step, func(t *testing.T) {
			t.Parallel()
			repo := newDependencyRepository()
			failure := errors.New("repository unavailable")
			repo.failures[step] = failure
			response, err := newDependencyService(
				repo,
			).UpdateDependencyType(t.Context(), 1, 3, dto.UpdateDependencyRequest{Type: "ss"})
			wantWrites := 0
			if step == "update" {
				wantWrites = 1
			}
			if !errors.Is(err, failure) || response != nil || repo.writes != wantWrites {
				t.Fatalf("update error changed: %+v, %v", repo, err)
			}
		})
	}
}

func TestDependencyListAndDeleteContracts(t *testing.T) {
	t.Parallel()
	repo := newDependencyRepository()
	svc := newDependencyService(repo)
	items, err := svc.ListDependencies(t.Context(), 1)
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("nil list changed: %+v, %v", items, err)
	}
	repo.rows = []sqlc.TaskDependency{repo.dep, {ID: 4, TaskID: 1, DependsOnTaskID: 5, Type: "sf"}}
	items, err = svc.ListDependencies(t.Context(), 1)
	if err != nil || len(items) != 2 || items[0].ID != 3 || items[1].ID != 4 || items[1].Type != "sf" {
		t.Fatalf("ordered mapping changed: %+v, %v", items, err)
	}
	repo.failures["list"] = errors.New("list unavailable")
	if _, err = svc.ListDependencies(t.Context(), 1); !errors.Is(err, repo.failures["list"]) {
		t.Fatalf("list error changed: %v", err)
	}
	if _, err = svc.ListDependencies(t.Context(), 0); !errors.Is(err, errorsapi.ErrValidation) {
		t.Fatalf("invalid task accepted: %v", err)
	}
	if err = svc.DeleteDependency(t.Context(), 9, 3); !errors.Is(err, errorsapi.ErrValidation) || repo.writes != 0 {
		t.Fatalf("foreign link deleted: %v", err)
	}
	if err = svc.DeleteDependency(t.Context(), 1, 3); err != nil || repo.writes != 1 {
		t.Fatalf("delete failed: %v", err)
	}
	repo.failures["find"] = errorsapi.ErrNotFound
	if err = svc.DeleteDependency(t.Context(), 1, 3); err != nil || repo.writes != 1 {
		t.Fatalf("missing delete not idempotent: %v", err)
	}
	repo.failures["find"] = errors.New("find unavailable")
	if err = svc.DeleteDependency(t.Context(), 1, 3); !errors.Is(err, repo.failures["find"]) {
		t.Fatalf("find error swallowed: %v", err)
	}
	delete(repo.failures, "find")
	repo.failures["delete"] = errors.New("delete unavailable")
	if err = svc.DeleteDependency(t.Context(), 1, 3); !errors.Is(err, repo.failures["delete"]) {
		t.Fatalf("delete error swallowed: %v", err)
	}
}
