package delivery_test

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	task "github.com/Koshsky/erp-backend/internal/project_mgmt/task"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type taskAccessRepository struct {
	task.Repository

	reads, writes int
	row           *sqlc.Task
	scope         access.ListScope
}

func taskRow(id int64) (*sqlc.Task, error) {
	if id < 1 || id > 4 {
		return nil, errorsapi.ErrNotFound
	}
	process, owner := int64(11), int64(8)
	if id == 1 {
		owner = 7
	}
	if id == 4 {
		process = 22
	}
	row := &sqlc.Task{
		ID:        id,
		ProcessID: process,
		OwnerID:   pgtype.Int8{Int64: owner, Valid: true},
		Title:     "Original",
		Status:    "not_started",
		StartDate: "2026-01-01",
		EndDate:   "2026-01-03",
		SortOrder: int32(id),
	}
	if id == 3 {
		row.ParentID = pgtype.Int8{Int64: 1, Valid: true}
		row.OwnerID = pgtype.Int8{Int64: 7, Valid: true}
	}
	return row, nil
}
func processOwners(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 11:
		return access.Owners{ProjectOwner: 9, ProcessOwner: 7}, nil
	case 22:
		return access.Owners{ProjectOwner: 10, ProcessOwner: 8}, nil
	default:
		return access.Owners{}, errorsapi.ErrNotFound
	}
}
func taskOwners(ctx context.Context, id int64) (access.Owners, error) {
	row, err := taskRow(id)
	if err != nil {
		return access.Owners{}, err
	}
	owners, err := processOwners(ctx, row.ProcessID)
	owners.Owner = row.OwnerID.Int64
	return owners, err
}
func (r *taskAccessRepository) FindTask(_ context.Context, id int64) (*sqlc.Task, error) {
	r.reads++
	return taskRow(id)
}
func (r *taskAccessRepository) CreateTask(_ context.Context, row sqlc.Task) (*sqlc.Task, error) {
	r.writes++
	row.ID = 5
	row.SortOrder = 5
	r.row = &row
	return &row, nil
}
func (r *taskAccessRepository) UpdateTask(_ context.Context, row sqlc.Task) (*sqlc.Task, error) {
	r.writes++
	r.row = &row
	return &row, nil
}
func (r *taskAccessRepository) DeleteTask(context.Context, int64) error { r.writes++; return nil }

func (r *taskAccessRepository) ListTasks(
	_ context.Context,
	_ int64,
	scope access.ListScope,
	_ int64,
	_, _ int,
) ([]sqlc.Task, error) {
	r.reads++
	r.scope = scope
	return nil, nil
}
func (r *taskAccessRepository) CountTasks(context.Context, int64, access.ListScope, int64) (int64, error) {
	return 0, nil
}
func (r *taskAccessRepository) ListTaskIDsByProcess(context.Context, int64) ([]int64, error) {
	r.reads++
	return []int64{1, 2, 3}, nil
}
func (r *taskAccessRepository) ReorderTasks(context.Context, []int64) error { r.writes++; return nil }

func taskRouter(user access.UserContext, repo *taskAccessRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(
		nil,
		tracing.New(nil),
		rbac.Data{TaskOwners: taskOwners, ProcessOwners: processOwners},
		rbac.ProvideAll(),
	)
	svc := task.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo, nil)
	handler := delivery.NewTaskHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}
func taskParents(ctx context.Context, res access.Resource, id int64) ([]engine.Target, error) {
	if res != access.ResourceTask {
		return nil, nil
	}
	row, err := taskRow(id)
	if err != nil {
		return nil, err
	}
	owners, err := processOwners(ctx, row.ProcessID)
	parents := []engine.Target{
		{Res: access.ResourceProcess, ID: row.ProcessID, Owners: owners},
		{Res: access.ResourceProject, ID: 31, Owners: access.Owners{ProjectOwner: owners.ProjectOwner}},
	}
	if row.ParentID.Valid {
		parentOwners, parentErr := taskOwners(ctx, row.ParentID.Int64)
		if parentErr != nil {
			return nil, parentErr
		}
		parents = append(parents, engine.Target{Res: access.ResourceTask, ID: row.ParentID.Int64, Owners: parentOwners})
	}
	return parents, err
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot and parent probe.
func TestTaskHTTPProcessRightsAndInheritedView(t *testing.T) {
	t.Cleanup(func() {
		engine.SetOwnerProbe(nil)
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	input := engine.DefaultPublishInput()
	input.Grants = append(
		input.Grants,
		engine.RuleGrant{Sub: "process-viewer", Key: "process/view", Scope: "process_owner"},
		engine.RuleGrant{Sub: "task-viewer", Key: "task/view", Scope: "down"},
	)
	if err := engine.Publish(input); err != nil {
		t.Fatal(err)
	}
	engine.SetOwnerProbe(
		&engine.OwnerProbe{
			Parents: taskParents,
			Descendant: func(_ context.Context, res access.Resource, id, user int64) (bool, error) {
				return res == access.ResourceTask && id == 1 && user == 7, nil
			},
		},
	)
	vp := access.UserContext{ID: 7, Preset: "vp"}
	rp := access.UserContext{ID: 9, Preset: "rp"}
	viewer := access.UserContext{ID: 7, Preset: "process-viewer"}
	parentViewer := access.UserContext{ID: 7, Preset: "task-viewer"}
	denied := access.UserContext{ID: 7, Preset: "worker"}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"owned process foreign task read", "GET", "/2", "", vp, 200, 0},
		{"foreign process read denied", "GET", "/4", "", vp, 404, 0},
		{"process view opens task", "GET", "/2", "", viewer, 200, 0},
		{"task view opens subtask", "GET", "/3", "", parentViewer, 200, 0},
		{"inherited view cannot update", "PUT", "/2", `{"title":"Changed"}`, viewer, 403, 0},
		{"task view cannot update subtask", "PUT", "/3", `{"title":"Changed"}`, parentViewer, 403, 0},
		{"inherited view cannot delete", "DELETE", "/3", "", viewer, 403, 0},
		{"process owner updates foreign task", "PUT", "/2", `{"owner_id":9,"responsible_id":8,"status":"in_progress"}`, vp, 200, 1},
		{"foreign process update denied", "PUT", "/4", `{"title":"Changed"}`, vp, 403, 0},
		{"project owner updates task", "PUT", "/2", `{"title":"Changed"}`, rp, 200, 1},
		{"project owner updates subtask", "PUT", "/3", `{"title":"Changed"}`, rp, 200, 1},
		{"immutable relations ignored", "PUT", "/3", `{"process_id":22,"parent_id":4,"order":99}`, vp, 200, 1},
		{"process owner deletes foreign task", "DELETE", "/2", "", vp, 204, 1},
		{"process owner deletes subtask", "DELETE", "/3", "", vp, 204, 1},
		{"foreign process delete denied", "DELETE", "/4", "", vp, 403, 0},
		{"create top level", "POST", "", `{"process_id":11,"title":"New","start_date":"2026-01-01","end_date":"2026-01-03"}`, vp, 201, 1},
		{"create subtask", "POST", "", `{"process_id":11,"parent_id":1,"title":"Operation"}`, vp, 201, 1},
		{"create foreign process denied", "POST", "", `{"process_id":22,"title":"New","start_date":"2026-01-01","end_date":"2026-01-03"}`, vp, 403, 0},
		{"inherited view cannot create", "POST", "", `{"process_id":11,"title":"New","start_date":"2026-01-01","end_date":"2026-01-03"}`, viewer, 403, 0},
		{"process owner list", "GET", "", "", vp, 200, 0},
		{"inherited list", "GET", "", "", viewer, 200, 0},
		{"no access list", "GET", "", "", denied, 403, 0},
		{"no access read", "GET", "/1", "", denied, 404, 0},
		{"missing read", "GET", "/99", "", vp, 404, 0},
		{"missing update", "PUT", "/99", `{"title":"Changed"}`, vp, 404, 0},
		{"missing delete", "DELETE", "/99", "", vp, 404, 0},
		{"reorder own process", "PUT", "/order", `{"process_id":11,"ids":[2,1,3]}`, vp, 204, 1},
		{"reorder foreign process denied", "PUT", "/order", `{"process_id":22,"ids":[4]}`, vp, 403, 0},
		{"inherited view cannot reorder", "PUT", "/order", `{"process_id":11,"ids":[2,1,3]}`, viewer, 403, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &taskAccessRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/task"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			taskRouter(tc.user, repo).ServeHTTP(response, request)
			if response.Code != tc.status || repo.writes != tc.writes {
				t.Fatalf(
					"status=%d reads=%d writes=%d body=%s",
					response.Code,
					repo.reads,
					repo.writes,
					response.Body.String(),
				)
			}
			if (tc.status == 403 || tc.status == 404) && repo.reads != 0 {
				t.Fatal("denied task reached core repository")
			}
			checkTaskMutation(t, tc.name, repo)
		})
	}
}
func checkTaskMutation(t *testing.T, name string, repo *taskAccessRepository) {
	t.Helper()
	switch name {
	case "immutable relations ignored":
		if repo.row.ProcessID != 11 || repo.row.ParentID.Int64 != 1 || repo.row.SortOrder != 3 {
			t.Fatal("patch changed immutable relations/order")
		}
	case "process owner updates foreign task":
		if repo.row.OwnerID.Int64 != 9 || repo.row.ResponsibleID.Int64 != 8 || repo.row.Status != "in_progress" {
			t.Fatal("task fields lost")
		}
	case "create top level":
		if repo.row.OwnerID.Int64 != 7 || repo.row.Status != "not_started" || repo.row.ParentID.Valid {
			t.Fatal("create owner/default status lost")
		}
	case "create subtask":
		if repo.row.ParentID.Int64 != 1 || repo.row.StartDate != "2026-01-01" || repo.row.EndDate != "2026-01-03" {
			t.Fatal("subtask parent/dates lost")
		}
	case "process owner list":
		if !repo.scope.ProcessOwner {
			t.Fatal("process scope lost")
		}
	case "inherited list":
		if len(repo.scope.ProcessView) != 1 {
			t.Fatal("inherited process scope lost")
		}
	}
}
