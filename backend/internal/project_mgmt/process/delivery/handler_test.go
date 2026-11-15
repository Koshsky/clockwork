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
	process "github.com/Koshsky/erp-backend/internal/project_mgmt/process"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type processAccessRepository struct {
	process.Repository

	reads, writes int
	scope         access.ListScope
	row           *sqlc.Process
}

func projectOwners(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 11, 12:
		return access.Owners{ProjectOwner: 7}, nil
	case 22:
		return access.Owners{ProjectOwner: 9}, nil
	default:
		return access.Owners{}, errorsapi.ErrNotFound
	}
}
func processRow(id int64) (*sqlc.Process, error) {
	if id < 1 || id > 4 {
		return nil, errorsapi.ErrNotFound
	}
	project, owner := int64(11), int64(7)
	if id >= 3 {
		project = 22
	}
	if id == 2 || id == 4 {
		owner = 8
	}
	return &sqlc.Process{
		ID:        id,
		ProjectID: project,
		OwnerID:   pgtype.Int8{Int64: owner, Valid: true},
		Title:     "Original",
		StartDate: "2026-01-01",
		EndDate:   "2026-01-03",
		SortOrder: int32(id),
	}, nil
}
func (r *processAccessRepository) FindProcess(_ context.Context, id int64) (*sqlc.Process, error) {
	r.reads++
	return processRow(id)
}

func (r *processAccessRepository) CreateProcess(
	_ context.Context,
	project int64,
	title string,
	color *string,
	owner, responsible *int64,
	start, end date.Date,
) (*sqlc.Process, error) {
	r.writes++
	r.row = &sqlc.Process{
		ID:            5,
		ProjectID:     project,
		OwnerID:       nullable.ToInt8(owner),
		ResponsibleID: nullable.ToInt8(responsible),
		Title:         title,
		Color:         nullable.ToString(color),
		StartDate:     start,
		EndDate:       end,
	}
	return r.row, nil
}
func (r *processAccessRepository) UpdateProcess(_ context.Context, row sqlc.Process) (*sqlc.Process, error) {
	r.writes++
	r.row = &row
	return &row, nil
}
func (r *processAccessRepository) DeleteProcess(context.Context, int64) error { r.writes++; return nil }

func (r *processAccessRepository) ListProcesss(
	_ context.Context,
	_ int64,
	scope access.ListScope,
	_ int64,
	_, _ int,
) ([]sqlc.Process, error) {
	r.reads++
	r.scope = scope
	return nil, nil
}
func (r *processAccessRepository) CountProcesses(context.Context, int64, access.ListScope, int64) (int64, error) {
	return 0, nil
}
func (r *processAccessRepository) ListProcessIDsByProject(context.Context, int64) ([]int64, error) {
	r.reads++
	return []int64{1, 2}, nil
}
func (r *processAccessRepository) ReorderProcesses(context.Context, []int64) error {
	r.writes++
	return nil
}

func processRouter(user access.UserContext, repo *processAccessRepository) *gin.Engine {
	data := rbac.Data{
		ProjectOwners: projectOwners,
		ProcessOwners: func(ctx context.Context, id int64) (access.Owners, error) {
			row, err := processRow(id)
			if err != nil {
				return access.Owners{}, err
			}
			owners, err := projectOwners(ctx, row.ProjectID)
			owners.ProcessOwner = row.OwnerID.Int64
			return owners, err
		},
	}
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), data, rbac.ProvideAll())
	svc := process.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewProcessHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot and ownership probe.
func TestProcessHTTPProjectRightsAndInheritedView(t *testing.T) {
	t.Cleanup(func() {
		engine.SetOwnerProbe(nil)
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	input := engine.DefaultPublishInput()
	input.Grants = append(input.Grants, engine.RuleGrant{Sub: "project-viewer", Key: "project/view", Scope: "self"})
	if err := engine.Publish(input); err != nil {
		t.Fatal(err)
	}
	engine.SetOwnerProbe(
		&engine.OwnerProbe{Parents: func(ctx context.Context, res access.Resource, id int64) ([]engine.Target, error) {
			if res != access.ResourceProcess {
				return nil, nil
			}
			row, err := processRow(id)
			if err != nil {
				return nil, err
			}
			owners, err := projectOwners(ctx, row.ProjectID)
			return []engine.Target{{Res: access.ResourceProject, ID: row.ProjectID, Owners: owners}}, err
		}, Related: func(_ context.Context, target engine.Target, user int64, scope string) (bool, error) {
			return target.Res == access.ResourceProject && target.ID == 22 && user == 7 &&
				scope == "process_projects", nil
		}},
	)
	rp := access.UserContext{ID: 7, Preset: "rp"}
	vp := access.UserContext{ID: 7, Preset: "vp"}
	viewer := access.UserContext{ID: 7, Preset: "project-viewer"}
	denied := access.UserContext{ID: 7, Preset: "worker"}
	admin := access.UserContext{ID: 7, Admin: true}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"owned project foreign process read", "GET", "/2", "", rp, 200, 0},
		{"foreign project read denied", "GET", "/4", "", rp, 404, 0},
		{"own process read", "GET", "/3", "", vp, 200, 0},
		{"visible project opens foreign process", "GET", "/4", "", vp, 200, 0},
		{"inherited view", "GET", "/2", "", viewer, 200, 0},
		{"inherited view cannot update", "PUT", "/2", `{"title":"Changed"}`, viewer, 403, 0},
		{"inherited view cannot delete", "DELETE", "/2", "", viewer, 403, 0},
		{"project owner update foreign process", "PUT", "/2", `{"title":"Changed","responsible_id":8}`, rp, 200, 1},
		{"foreign update denied", "PUT", "/4", `{"title":"Changed"}`, rp, 403, 0},
		{"process owner update", "PUT", "/3", `{"title":"Changed"}`, vp, 200, 1},
		{"inherited project does not allow mutation", "PUT", "/4", `{"title":"Changed"}`, vp, 403, 0},
		{"move to owned project", "PUT", "/2", `{"project_id":12}`, rp, 200, 1},
		{"move to foreign project denied", "PUT", "/2", `{"project_id":22}`, rp, 403, 0},
		{"missing target project", "PUT", "/2", `{"project_id":99}`, rp, 404, 0},
		{"owner cannot escape process ownership", "PUT", "/3", `{"owner_id":8}`, vp, 403, 0},
		{"admin owner change", "PUT", "/3", `{"owner_id":8,"responsible_id":9}`, admin, 200, 1},
		{"date shift", "PUT", "/2", `{"start_date":"2027-01-01","end_date":"2027-01-03"}`, rp, 200, 1},
		{"project owner deletes foreign process", "DELETE", "/2", "", rp, 204, 1},
		{"foreign delete denied", "DELETE", "/4", "", rp, 403, 0},
		{"process owner delete", "DELETE", "/3", "", vp, 204, 1},
		{"inherited project does not allow delete", "DELETE", "/4", "", vp, 403, 0},
		{"create in owned project", "POST", "", `{"project_id":11,"owner_id":8,"title":"New","start_date":"2026-01-01","end_date":"2026-01-02"}`, rp, 201, 1},
		{"create in foreign project denied", "POST", "", `{"project_id":22,"owner_id":7,"title":"New","start_date":"2026-01-01","end_date":"2026-01-02"}`, rp, 403, 0},
		{"inherited view cannot create", "POST", "", `{"project_id":11,"title":"New","start_date":"2026-01-01","end_date":"2026-01-02"}`, viewer, 403, 0},
		{"own project list", "GET", "", "", rp, 200, 0},
		{"inherited list", "GET", "", "", viewer, 200, 0},
		{"no access list", "GET", "", "", denied, 403, 0},
		{"no access read", "GET", "/1", "", denied, 404, 0},
		{"missing read", "GET", "/99", "", rp, 404, 0},
		{"missing update", "PUT", "/99", `{"title":"Changed"}`, rp, 404, 0},
		{"missing delete", "DELETE", "/99", "", rp, 404, 0},
		{"reorder owned project", "PUT", "/order", `{"project_id":11,"ids":[2,1]}`, rp, 204, 1},
		{"reorder foreign project denied", "PUT", "/order", `{"project_id":22,"ids":[3,4]}`, rp, 403, 0},
		{"process owner cannot reorder whole project", "PUT", "/order", `{"project_id":22,"ids":[3,4]}`, vp, 403, 0},
		{"inherited view cannot reorder", "PUT", "/order", `{"project_id":11,"ids":[2,1]}`, viewer, 403, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &processAccessRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/process"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			processRouter(tc.user, repo).ServeHTTP(response, request)
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
				t.Fatal("denied process reached core repository")
			}
			checkProcessMutation(t, tc.name, repo)
		})
	}
}

func checkProcessMutation(t *testing.T, name string, repo *processAccessRepository) {
	t.Helper()
	switch name {
	case "move to owned project":
		if repo.row.ProjectID != 12 || repo.row.OwnerID.Int64 != 8 || repo.row.SortOrder != 2 {
			t.Fatal("project move changed unrelated fields")
		}
	case "admin owner change":
		if repo.row.OwnerID.Int64 != 8 || repo.row.ResponsibleID.Int64 != 9 || repo.row.ProjectID != 22 {
			t.Fatal("owner change lost fields")
		}
	case "date shift":
		if repo.row.StartDate != "2027-01-01" || repo.row.EndDate != "2027-01-03" {
			t.Fatal("date shift lost dates")
		}
	case "own project list":
		if !repo.scope.ProjectOwner {
			t.Fatal("project owner scope lost")
		}
	case "inherited list":
		if len(repo.scope.ProjectView) != 1 || repo.scope.ProjectView[0] != "self" {
			t.Fatal("project view scope lost")
		}
	}
}
