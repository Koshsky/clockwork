package delivery_test

import (
	"context"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	dependency "github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type dependencyAccessRepository struct {
	dependency.Repository

	reads, writes int
	created       *sqlc.TaskDependency
}

func (r *dependencyAccessRepository) ListDependenciesByTask(
	_ context.Context,
	task int64,
) ([]sqlc.TaskDependency, error) {
	r.reads++
	return []sqlc.TaskDependency{{ID: 3, TaskID: task, DependsOnTaskID: 2, Type: "fs"}}, nil
}
func (r *dependencyAccessRepository) ValidateLink(_ context.Context, task, pred int64) (sqlc.ValidateLinkRow, error) {
	r.reads++
	return sqlc.ValidateLinkRow{
		TaskID:        task,
		PredID:        pred,
		TaskProcessID: 11,
		PredProcessID: 11,
		TaskIsTop:     true,
		PredIsTop:     true,
		TaskStartDate: "2026-02-10",
		TaskEndDate:   "2026-02-20",
		PredStartDate: "2026-02-01",
		PredEndDate:   "2026-02-10",
	}, nil
}
func (r *dependencyAccessRepository) DependencyExists(context.Context, int64, int64) (bool, error) {
	return false, nil
}
func (r *dependencyAccessRepository) DependencyCycle(context.Context, int64, int64) (bool, error) {
	return false, nil
}

func (r *dependencyAccessRepository) CreateDependency(
	_ context.Context,
	task, pred int64,
	typ string,
) (*sqlc.TaskDependency, error) {
	r.writes++
	r.created = &sqlc.TaskDependency{ID: 3, TaskID: task, DependsOnTaskID: pred, Type: typ}
	return r.created, nil
}
func (r *dependencyAccessRepository) FindDependency(_ context.Context, id int64) (*sqlc.TaskDependency, error) {
	r.reads++
	switch id {
	case 3:
		return &sqlc.TaskDependency{ID: 3, TaskID: 1, DependsOnTaskID: 2, Type: "fs"}, nil
	case 4:
		return &sqlc.TaskDependency{ID: 4, TaskID: 22, DependsOnTaskID: 23, Type: "ss"}, nil
	default:
		return nil, errorsapi.ErrNotFound
	}
}

func (r *dependencyAccessRepository) UpdateDependencyType(
	_ context.Context,
	id int64,
	typ string,
) (*sqlc.TaskDependency, error) {
	r.writes++
	return &sqlc.TaskDependency{ID: id, TaskID: 1, DependsOnTaskID: 2, Type: typ}, nil
}
func (r *dependencyAccessRepository) DeleteDependency(context.Context, int64) error {
	r.writes++
	return nil
}

func dependencyRouter(user access.UserContext, repo *dependencyAccessRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(
		nil,
		tracing.New(nil),
		rbac.Data{TaskOwners: func(_ context.Context, id int64) (access.Owners, error) {
			switch id {
			case 1:
				return access.Owners{ProjectOwner: 9, ProcessOwner: 7, Owner: 7}, nil
			case 22:
				return access.Owners{ProjectOwner: 9, ProcessOwner: 8, Owner: 8}, nil
			default:
				return access.Owners{}, errorsapi.ErrNotFound
			}
		}},
		rbac.ProvideAll(),
	)
	svc := dependency.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewTaskDependencyHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestDependencyHTTPTaskAccessAndEndpointBinding(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	input := engine.PublishInput{
		Grants: []engine.RuleGrant{
			{Sub: "dependency-owner", Key: "task/view", Scope: "process_owner"},
			{Sub: "dependency-owner", Key: "task/update", Scope: "process_owner"},
			{Sub: "dependency-viewer", Key: "task/view", Scope: "all"},
		},
	}
	if err := engine.Publish(input); err != nil {
		t.Fatal(err)
	}
	owner := access.UserContext{ID: 7, Preset: "dependency-owner"}
	viewer := access.UserContext{ID: 7, Preset: "dependency-viewer"}
	denied := access.UserContext{ID: 7}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"visible list", "GET", "1/dependencies", "", viewer, 200, 0},
		{"hidden list", "GET", "22/dependencies", "", owner, 404, 0},
		{"no rights list", "GET", "1/dependencies", "", denied, 404, 0},
		{"owner create", "POST", "1/dependencies", `{"depends_on_task_id":2,"type":"fs","task_id":22}`, owner, 201, 1},
		{"viewer create denied", "POST", "1/dependencies", `{"depends_on_task_id":2,"type":"fs"}`, viewer, 403, 0},
		{"foreign task create denied", "POST", "22/dependencies", `{"depends_on_task_id":2,"type":"fs"}`, owner, 403, 0},
		{"self link denied", "POST", "1/dependencies", `{"depends_on_task_id":1,"type":"fs"}`, owner, 400, 0},
		{"owner update", "PUT", "1/dependencies/3", `{"type":"fs"}`, owner, 200, 1},
		{"foreign edge update", "PUT", "1/dependencies/4", `{"type":"ss"}`, owner, 400, 0},
		{"viewer update denied", "PUT", "1/dependencies/3", `{"type":"fs"}`, viewer, 403, 0},
		{"foreign task update denied", "PUT", "22/dependencies/3", `{"type":"fs"}`, owner, 403, 0},
		{"owner delete", "DELETE", "1/dependencies/3", "", owner, 204, 1},
		{"foreign edge delete", "DELETE", "1/dependencies/4", "", owner, 400, 0},
		{"viewer delete denied", "DELETE", "1/dependencies/3", "", viewer, 403, 0},
		{"foreign task delete denied", "DELETE", "22/dependencies/3", "", owner, 403, 0},
		{"missing delete idempotent", "DELETE", "1/dependencies/99", "", owner, 204, 0},
		{"missing update", "PUT", "1/dependencies/99", `{"type":"fs"}`, owner, 404, 0},
		{"missing task", "GET", "99/dependencies", "", owner, 404, 0},
		{"invalid task id", "GET", "bad/dependencies", "", owner, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &dependencyAccessRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/task/"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			dependencyRouter(tc.user, repo).ServeHTTP(response, request)
			if response.Code != tc.status || repo.writes != tc.writes {
				t.Fatalf(
					"status=%d reads=%d writes=%d body=%s",
					response.Code,
					repo.reads,
					repo.writes,
					response.Body.String(),
				)
			}
			if tc.status == 403 && repo.reads != 0 {
				t.Fatal("denied task reached core repository")
			}
			if repo.created != nil && (repo.created.TaskID != 1 || repo.created.DependsOnTaskID != 2) {
				t.Fatal("request body overrode endpoint binding")
			}
		})
	}
}
