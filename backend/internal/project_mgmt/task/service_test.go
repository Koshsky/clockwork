package task_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	task "github.com/Koshsky/erp-backend/internal/project_mgmt/task"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/dto"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type taskRepository struct {
	row, parent                           *sqlc.Task
	rows                                  []sqlc.Task
	foundErr, writeErr, listErr, countErr error
	writes, counts, idReads               int
	user, owner, process                  int64
	scope                                 access.ListScope
	limit, offset                         int
	reordered                             []int64
}

func taskFixture() sqlc.Task {
	return sqlc.Task{
		ID:            3,
		ProcessID:     11,
		OwnerID:       pgtype.Int8{Int64: 7, Valid: true},
		ResponsibleID: pgtype.Int8{Int64: 8, Valid: true},
		Title:         "Задача <one>",
		Color:         sql.NullString{String: "#ab12EF", Valid: true},
		Status:        "not_started",
		StartDate:     "2026-12-31",
		EndDate:       "2027-01-02",
		SortOrder:     4,
	}
}
func newService(repo *taskRepository) *task.Service {
	return task.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo, nil)
}
func (r *taskRepository) CreateTask(_ context.Context, row sqlc.Task) (*sqlc.Task, error) {
	r.writes++
	row.ID = 3
	row.SortOrder = 4
	r.row = &row
	return &row, r.writeErr
}
func (r *taskRepository) FindTask(_ context.Context, id int64) (*sqlc.Task, error) {
	row := r.row
	if id == 1 {
		row = r.parent
	}
	if row == nil {
		return nil, r.foundErr
	}
	copyRow := *row
	return &copyRow, r.foundErr
}
func (r *taskRepository) UpdateTask(_ context.Context, row sqlc.Task) (*sqlc.Task, error) {
	r.writes++
	r.row = &row
	return &row, r.writeErr
}
func (r *taskRepository) DeleteTask(context.Context, int64) error { r.writes++; return r.writeErr }

func (r *taskRepository) ListTasks(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
	limit, offset int,
) ([]sqlc.Task, error) {
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return r.rows, r.listErr
}
func (r *taskRepository) CountTasks(_ context.Context, user int64, scope access.ListScope, owner int64) (int64, error) {
	r.counts++
	if user != r.user || owner != r.owner || !reflect.DeepEqual(scope, r.scope) {
		return 0, errors.New("list/count scope mismatch")
	}
	return 17, r.countErr
}
func (r *taskRepository) ListTaskIDsByProcess(_ context.Context, process int64) ([]int64, error) {
	r.idReads++
	r.process = process
	return []int64{1, 2}, r.foundErr
}
func (r *taskRepository) ReorderTasks(_ context.Context, ids []int64) error {
	r.writes++
	r.reordered = ids
	return r.writeErr
}

func prepareSubtask(request *dto.CreateTaskRequest, repo *taskRepository, want *sqlc.Task) {
	request.ParentID = new(int64(1))
	request.StartDate = nil
	request.EndDate = nil
	repo.parent = &sqlc.Task{
		ID:        1,
		ProcessID: 11,
		OwnerID:   pgtype.Int8{Int64: 9, Valid: true},
		StartDate: "2026-12-30",
		EndDate:   "2027-01-05",
	}
	want.ParentID = pgtype.Int8{Int64: 1, Valid: true}
	want.StartDate = "2026-12-30"
	want.EndDate = "2027-01-05"
}

func TestTaskCreationParentAndStatus(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		change  func(*dto.CreateTaskRequest, *taskRepository, *sqlc.Task)
		invalid bool
	}{
		{"default status", func(*dto.CreateTaskRequest, *taskRepository, *sqlc.Task) {}, false},
		{"empty status defaults", func(q *dto.CreateTaskRequest, _ *taskRepository, _ *sqlc.Task) { q.Status = new("") }, false},
		{"in progress", func(q *dto.CreateTaskRequest, _ *taskRepository, w *sqlc.Task) {
			q.Status = new("in_progress")
			w.Status = "in_progress"
		}, false},
		{"done", func(q *dto.CreateTaskRequest, _ *taskRepository, w *sqlc.Task) {
			q.Status = new("done")
			w.Status = "done"
		}, false},
		{"subtask inherits dates", prepareSubtask, false},
		{"subtask ignores supplied dates", func(q *dto.CreateTaskRequest, r *taskRepository, w *sqlc.Task) {
			prepareSubtask(q, r, w)
			q.StartDate = new(date.Date("2025-01-01"))
			q.EndDate = new(date.Date("2025-01-02"))
		}, false},
		{"missing parent", func(q *dto.CreateTaskRequest, _ *taskRepository, _ *sqlc.Task) { q.ParentID = new(int64(1)) }, true},
		{"missing parent error", func(q *dto.CreateTaskRequest, r *taskRepository, _ *sqlc.Task) {
			q.ParentID = new(int64(1))
			r.foundErr = errorsapi.ErrNotFound
		}, true},
		{"parent is subtask", func(q *dto.CreateTaskRequest, r *taskRepository, w *sqlc.Task) {
			prepareSubtask(q, r, w)
			r.parent.ParentID = pgtype.Int8{Int64: 2, Valid: true}
		}, true},
		{"parent in different process", func(q *dto.CreateTaskRequest, r *taskRepository, w *sqlc.Task) {
			prepareSubtask(q, r, w)
			r.parent.ProcessID = 22
		}, true},
		{"zero parent", func(q *dto.CreateTaskRequest, _ *taskRepository, _ *sqlc.Task) { q.ParentID = new(int64(0)) }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			want := taskFixture()
			repo := &taskRepository{}
			request := dto.CreateTaskRequest{
				ProcessID:     11,
				OwnerID:       new(int64(7)),
				ResponsibleID: new(int64(8)),
				Title:         want.Title,
				Color:         new("#ab12EF"),
				StartDate:     new(want.StartDate),
				EndDate:       new(want.EndDate),
			}
			tc.change(&request, repo, &want)
			response, err := newService(repo).CreateTask(t.Context(), request)
			if tc.invalid {
				if !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 {
					t.Fatalf("invalid parent/create reached write: %+v, %v", repo, err)
				}
				return
			}
			if err != nil || repo.row == nil || *repo.row != want ||
				!reflect.DeepEqual(response, task.NewMapper().ToDTO(&want)) {
				t.Fatalf("create status/parent/owner changed: %+v, %v", response, err)
			}
		})
	}
}

func TestTaskPatchKeepsImmutableRelationsAndOrder(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, body string
		change     func(*sqlc.Task)
	}{
		{"absent", `{}`, func(*sqlc.Task) {}},
		{"null", `{"owner_id":null,"responsible_id":null,"color":null,"status":null,"start_date":null}`, func(*sqlc.Task) {}},
		{"clear responsible", `{"responsible_id":0}`, func(r *sqlc.Task) { r.ResponsibleID = pgtype.Int8{} }},
		{"clear color", `{"color":""}`, func(r *sqlc.Task) { r.Color = sql.NullString{} }},
		{"relations ignored", `{"process_id":22,"parent_id":9,"order":99}`, func(*sqlc.Task) {}},
		{"replace", `{"owner_id":9,"responsible_id":10,"title":"Новая <T>","color":"#123456","status":"done","start_date":"2027-01-01","end_date":"2027-01-05"}`, func(r *sqlc.Task) {
			r.OwnerID = pgtype.Int8{Int64: 9, Valid: true}
			r.ResponsibleID = pgtype.Int8{Int64: 10, Valid: true}
			r.Title = "Новая <T>"
			r.Color = sql.NullString{String: "#123456", Valid: true}
			r.Status = "done"
			r.StartDate = "2027-01-01"
			r.EndDate = "2027-01-05"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			row := taskFixture()
			want := row
			tc.change(&want)
			repo := &taskRepository{row: &row}
			var request dto.UpdateTaskRequest
			if err := json.Unmarshal([]byte(tc.body), &request); err != nil {
				t.Fatal(err)
			}
			response, err := newService(repo).UpdateTask(t.Context(), 3, request)
			if err != nil || *repo.row != want || repo.writes != 1 ||
				!reflect.DeepEqual(response, task.NewMapper().ToDTO(&want)) {
				t.Fatalf("patch changed fields/relations: %+v, %v", response, err)
			}
		})
	}
}

func TestTaskValidationBeforeWrite(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{"title":" "}`, `{"color":"red"}`, `{"status":"unknown"}`, `{"start_date":""}`, `{"end_date":""}`, `{"end_date":"2026-12-30"}`} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			row := taskFixture()
			repo := &taskRepository{row: &row}
			svc := newService(repo)
			var patch dto.UpdateTaskRequest
			if err := json.Unmarshal([]byte(body), &patch); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.UpdateTask(
				t.Context(),
				3,
				patch,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil || repo.writes != 0 ||
				*repo.row != row {
				t.Fatalf("invalid patch reached write: %v", err)
			}
			request := dto.CreateTaskRequest{
				ProcessID: 11,
				Title:     row.Title,
				StartDate: new(row.StartDate),
				EndDate:   new(row.EndDate),
			}
			if err := json.Unmarshal([]byte(body), &request); err != nil {
				t.Fatal(err)
			}
			if response, err := svc.CreateTask(
				t.Context(),
				request,
			); !errors.Is(err, errorsapi.ErrValidation) || response != nil ||
				repo.writes != 0 {
				t.Fatalf("invalid create reached write: %v", err)
			}
		})
	}
}

func TestTaskListMappingAndScope(t *testing.T) {
	t.Parallel()
	mapper := task.NewMapper()
	if mapper.ToDTO(nil) != nil || mapper.ToDTOs(nil) == nil || len(mapper.ToDTOs(nil)) != 0 {
		t.Fatal("nil mapping changed")
	}
	for _, scope := range []access.ListScope{{All: true}, {ProcessOwner: true}, {ProjectOwner: true}, {ProcessView: []string{"self"}}} {
		row := taskFixture()
		repo := &taskRepository{
			rows: []sqlc.Task{
				row,
				{
					ID:        1,
					ProcessID: 11,
					ParentID:  pgtype.Int8{Int64: 3, Valid: true},
					Title:     "Subtask",
					Status:    "in_progress",
					SortOrder: 2,
				},
			},
		}
		items, total, err := newService(repo).ListTasks(t.Context(), 7, scope, 9, 20, 40)
		want := []dto.TaskResponse{
			{
				ID:            3,
				ProcessID:     11,
				OwnerID:       new(int64(7)),
				ResponsibleID: new(int64(8)),
				Title:         row.Title,
				Color:         new("#ab12EF"),
				Status:        "not_started",
				StartDate:     row.StartDate,
				EndDate:       row.EndDate,
				Order:         4,
			},
			{ID: 1, ProcessID: 11, ParentID: new(int64(3)), Title: "Subtask", Status: "in_progress", Order: 2},
		}
		if err != nil || total != 17 || !reflect.DeepEqual(items, want) {
			t.Fatalf("list mapping/order changed: %+v, %v", items, err)
		}
		if repo.user != 7 || repo.owner != 9 || repo.limit != 20 || repo.offset != 40 || repo.counts != 1 ||
			!reflect.DeepEqual(repo.scope, scope) {
			t.Fatalf("scope/pagination changed: %+v", repo)
		}
	}
}

func TestTaskReadDeleteFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name    string
		row     *sqlc.Task
		failure error
	}{{"missing", nil, errorsapi.ErrNotFound}, {"nil", nil, nil}, {"database", nil, failure}, {"existing", new(taskFixture()), nil}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &taskRepository{row: tc.row, foundErr: tc.failure}
			svc := newService(repo)
			checkTaskReadDelete(t, repo, svc, tc.failure, failure)
		})
	}
}
func checkTaskReadDelete(t *testing.T, repo *taskRepository, svc *task.Service, failure, unavailable error) {
	t.Helper()
	response, err := svc.FindTask(t.Context(), 3)
	want := failure
	if repo.row == nil && want == nil {
		want = errorsapi.ErrTaskNotFound
	}
	if errorsapi.IsNotFoundError(want) {
		want = errorsapi.ErrTaskNotFound
	}
	if !errors.Is(err, want) {
		t.Fatalf("read classification changed: %v", err)
	}
	if repo.row != nil && response == nil {
		t.Fatal("existing task not mapped")
	}
	if repo.row == nil {
		if _, err = svc.UpdateTask(
			t.Context(),
			3,
			dto.UpdateTaskRequest{},
		); !errors.Is(
			err,
			errorsapi.ErrTaskNotFound,
		) {
			t.Fatalf("update classification changed: %v", err)
		}
	}
	err = svc.DeleteTask(t.Context(), 3)
	want = nil
	writes := 0
	if errors.Is(failure, unavailable) {
		want = unavailable
	}
	if repo.row != nil {
		writes = 1
	}
	if !errors.Is(err, want) || repo.writes != writes {
		t.Fatalf("delete error/idempotency changed: %+v, %v", repo, err)
	}
}

func TestTaskWriteAndListFailures(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	row := taskFixture()
	repo := &taskRepository{row: &row, writeErr: failure}
	svc := newService(repo)
	request := dto.CreateTaskRequest{
		ProcessID: 11,
		Title:     row.Title,
		StartDate: new(row.StartDate),
		EndDate:   new(row.EndDate),
	}
	if _, err := svc.CreateTask(t.Context(), request); !errors.Is(err, failure) {
		t.Fatalf("create error changed: %v", err)
	}
	if _, err := svc.UpdateTask(t.Context(), 3, dto.UpdateTaskRequest{}); !errors.Is(err, failure) {
		t.Fatalf("update error changed: %v", err)
	}
	if err := svc.DeleteTask(t.Context(), 3); !errors.Is(err, failure) {
		t.Fatalf("delete error changed: %v", err)
	}
	for _, first := range []bool{true, false} {
		listRepo := &taskRepository{}
		if first {
			listRepo.listErr = failure
		} else {
			listRepo.countErr = failure
		}
		items, total, err := newService(listRepo).ListTasks(t.Context(), 7, access.ListScope{All: true}, 0, 50, 0)
		if !errors.Is(err, failure) || items != nil || total != 0 || (first && listRepo.counts != 0) {
			t.Fatalf("list/count failure changed: %+v, %v", listRepo, err)
		}
	}
}

func TestTaskReorderCompleteProcess(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name                        string
		ids                         []int64
		readError, writeError, want error
		reads, writes               int
	}{
		{"empty", nil, nil, nil, errorsapi.ErrValidation, 0, 0}, {"duplicate", []int64{1, 1}, nil, nil, errorsapi.ErrValidation, 0, 0},
		{"missing", []int64{1}, nil, nil, errorsapi.ErrValidation, 1, 0}, {"foreign", []int64{1, 9}, nil, nil, errorsapi.ErrValidation, 1, 0},
		{"valid", []int64{2, 1}, nil, nil, nil, 1, 1}, {"read failure", []int64{2, 1}, failure, nil, failure, 1, 0}, {"write failure", []int64{2, 1}, nil, failure, failure, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &taskRepository{foundErr: tc.readError, writeErr: tc.writeError}
			err := newService(repo).ReorderTasks(t.Context(), dto.ReorderTaskRequest{ProcessID: 11, IDs: tc.ids})
			if !errors.Is(err, tc.want) || repo.idReads != tc.reads || repo.writes != tc.writes {
				t.Fatalf("reorder validation changed: %+v, %v", repo, err)
			}
			if tc.reads > 0 && repo.process != 11 {
				t.Fatal("reordered wrong process")
			}
			if tc.writes > 0 && !reflect.DeepEqual(repo.reordered, tc.ids) {
				t.Fatalf("requested order changed: %v", repo.reordered)
			}
		})
	}
}
