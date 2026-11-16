package delivery_test

import (
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	project "github.com/Koshsky/erp-backend/internal/project_mgmt/project"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/project/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type projectAccessRepository struct {
	reads, writes int
	scope         access.ListScope
	row           *sqlc.Project
}

func projectOwners(_ context.Context, id int64) (access.Owners, error) {
	if id < 1 || id > 5 {
		return access.Owners{}, errorsapi.ErrNotFound
	}
	owner := int64(9)
	if id == 1 {
		owner = 7
	}
	return access.Owners{ProjectOwner: owner}, nil
}

func (r *projectAccessRepository) FindProject(ctx context.Context, id int64) (*sqlc.Project, error) {
	r.reads++
	owners, err := projectOwners(ctx, id)
	if err != nil {
		return nil, err
	}
	return &sqlc.Project{
		ID:        id,
		OwnerID:   pgtype.Int8{Int64: owners.ProjectOwner, Valid: true},
		Code:      "Original",
		StartDate: "2026-01-01",
		EndDate:   "2026-01-03",
		Priority:  2,
	}, nil
}

func (r *projectAccessRepository) CreateProject(
	_ context.Context,
	owner, responsible *int64,
	code string,
	color *string,
	start, end date.Date,
	priority int,
) (*sqlc.Project, error) {
	r.writes++
	r.row = &sqlc.Project{
		ID:            6,
		OwnerID:       nullable.ToInt8(owner),
		ResponsibleID: nullable.ToInt8(responsible),
		Code:          code,
		Color:         nullable.ToString(color),
		StartDate:     start,
		EndDate:       end,
		Priority:      int32(priority),
	}
	return r.row, nil
}

func (r *projectAccessRepository) UpdateProject(
	_ context.Context,
	row sqlc.Project,
	priority int,
) (*sqlc.Project, error) {
	r.writes++
	row.Priority = int32(priority)
	r.row = &row
	return &row, nil
}
func (r *projectAccessRepository) DeleteProject(context.Context, int64) error { r.writes++; return nil }

func (r *projectAccessRepository) ListProjects(
	_ context.Context,
	_ int64,
	scope access.ListScope,
	_ int64,
	_, _ int,
) ([]sqlc.Project, error) {
	r.reads++
	r.scope = scope
	return nil, nil
}
func (r *projectAccessRepository) CountProjects(context.Context, int64, access.ListScope, int64) (int64, error) {
	return 0, nil
}
func (r *projectAccessRepository) AutoCreatedCounts(context.Context, int64) (sqlc.CountAutoCreatedEntitiesRow, error) {
	return sqlc.CountAutoCreatedEntitiesRow{}, nil
}

func projectRouter(user access.UserContext, repo *projectAccessRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{ProjectOwners: projectOwners}, rbac.ProvideAll())
	svc := project.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewProjectHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

func publishProjectRules(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		engine.SetOwnerProbe(nil)
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	input := engine.DefaultPublishInput()
	for _, action := range []string{"view", "update", "delete"} {
		input.Grants = append(
			input.Grants,
			engine.RuleGrant{Sub: "project-down", Key: "project/" + action, Scope: "down"},
			engine.RuleGrant{Sub: "project-own", Key: "project/" + action, Scope: "self"},
		)
	}
	input.Grants = append(
		input.Grants,
		engine.RuleGrant{Sub: "project-own", Key: "project/create", Scope: "self"},
		engine.RuleGrant{Sub: "project-own", Key: "project/prioritize", Scope: "self"},
		engine.RuleGrant{Sub: "project-related", Key: "project/view", Scope: "process_projects"},
	)
	if err := engine.Publish(input); err != nil {
		t.Fatal(err)
	}
	engine.SetOwnerProbe(&engine.OwnerProbe{
		Descendant: func(_ context.Context, res access.Resource, id, user int64) (bool, error) {
			if id == 5 {
				return true, errors.New("ownership probe unavailable")
			}
			return res == access.ResourceProject && user == 7 && (id == 2 || id == 3), nil
		},
		Related: func(_ context.Context, target engine.Target, user int64, scope string) (bool, error) {
			return target.Res == access.ResourceProject && target.ID == 2 && user == 7 &&
				scope == "process_projects", nil
		},
	})
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot and ownership probe.
func TestProjectHTTPAccessAndPrioritization(t *testing.T) {
	publishProjectRules(t)
	own := access.UserContext{ID: 7, Preset: "project-own"}
	down := access.UserContext{ID: 7, Preset: "project-down"}
	related := access.UserContext{ID: 7, Preset: "project-related"}
	director := access.UserContext{ID: 7, Preset: "dp"}
	denied := access.UserContext{ID: 7, Preset: "worker"}
	admin := access.UserContext{ID: 7, Admin: true}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"own read", "GET", "/1", "", own, 200, 0},
		{"foreign read", "GET", "/4", "", own, 404, 0},
		{"process descendant read", "GET", "/2", "", down, 200, 0},
		{"task descendant read", "GET", "/3", "", down, 200, 0},
		{"unrelated read", "GET", "/4", "", down, 404, 0},
		{"probe failure denies", "GET", "/5", "", down, 404, 0},
		{"process related read", "GET", "/2", "", related, 200, 0},
		{"task does not grant process related", "GET", "/3", "", related, 404, 0},
		{"own list", "GET", "", "", own, 200, 0},
		{"down list", "GET", "", "", down, 200, 0},
		{"related list", "GET", "", "", related, 200, 0},
		{"no access list", "GET", "", "", denied, 403, 0},
		{"own update", "PUT", "/1", `{"code":"Updated"}`, own, 200, 1},
		{"foreign update", "PUT", "/4", `{"code":"Updated"}`, own, 403, 0},
		{"process descendant update", "PUT", "/2", `{"code":"Updated"}`, down, 200, 1},
		{"task descendant update", "PUT", "/3", `{"code":"Updated"}`, down, 200, 1},
		{"unrelated update", "PUT", "/4", `{"code":"Updated"}`, down, 403, 0},
		{"view does not grant update", "PUT", "/2", `{"code":"Updated"}`, related, 403, 0},
		{"own cannot transfer ownership", "PUT", "/1", `{"owner_id":9}`, own, 403, 0},
		{"director priority", "PUT", "/4", `{"priority":5}`, director, 200, 1},
		{"director cannot change metadata", "PUT", "/4", `{"code":"Updated"}`, director, 403, 0},
		{"director mixed patch denied", "PUT", "/4", `{"priority":5,"code":"Updated"}`, director, 403, 0},
		{"director empty patch denied", "PUT", "/4", `{}`, director, 403, 0},
		{"director cannot delete", "DELETE", "/4", "", director, 403, 0},
		{"own delete", "DELETE", "/1", "", own, 204, 1},
		{"foreign delete", "DELETE", "/4", "", own, 403, 0},
		{"process descendant delete", "DELETE", "/2", "", down, 204, 1},
		{"task descendant delete", "DELETE", "/3", "", down, 204, 1},
		{"unrelated delete", "DELETE", "/4", "", down, 403, 0},
		{"view does not grant delete", "DELETE", "/2", "", related, 403, 0},
		{"own create", "POST", "", `{"code":"New","owner_id":7,"start_date":"2026-01-01","end_date":"2026-01-01"}`, own, 201, 1},
		{"no access create", "POST", "", `{"code":"New","start_date":"2026-01-01","end_date":"2026-01-01"}`, denied, 403, 0},
		{"missing read", "GET", "/99", "", own, 404, 0},
		{"missing update", "PUT", "/99", `{"code":"Updated"}`, own, 404, 0},
		{"missing delete", "DELETE", "/99", "", own, 404, 0},
		{"admin owner and responsible", "PUT", "/4", `{"owner_id":7,"responsible_id":8}`, admin, 200, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &projectAccessRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/project"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			projectRouter(tc.user, repo).ServeHTTP(response, request)
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
				t.Fatal("denied project reached core repository")
			}
			checkProjectFields(t, tc.name, repo)
		})
	}
}

func checkProjectFields(t *testing.T, name string, repo *projectAccessRepository) {
	t.Helper()
	switch name {
	case "own list":
		if !repo.scope.Self {
			t.Fatal("own scope lost")
		}
	case "down list":
		if !repo.scope.Down {
			t.Fatal("descendant scope lost")
		}
	case "related list":
		if !repo.scope.ProcessProjects {
			t.Fatal("process-related scope lost")
		}
	case "director priority":
		if repo.row.Priority != 5 || repo.row.Code != "Original" || repo.row.OwnerID.Int64 != 9 ||
			repo.row.StartDate != "2026-01-01" ||
			repo.row.EndDate != "2026-01-03" {
			t.Fatalf("priority patch changed metadata: %+v", repo.row)
		}
	case "own create":
		if repo.row.OwnerID.Int64 != 7 {
			t.Fatal("create lost authenticated owner")
		}
	case "admin owner and responsible":
		if repo.row.OwnerID.Int64 != 7 || repo.row.ResponsibleID.Int64 != 8 {
			t.Fatal("owner/responsible change lost")
		}
	}
}
