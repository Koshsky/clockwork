package delivery_test

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	milestone "github.com/Koshsky/erp-backend/internal/project_mgmt/milestone"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/milestone/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

type handlerRepository struct {
	milestone.Repository

	writes int
	reads  int
	scope  access.ListScope
}

func httpFixture(id int64) *sqlc.Milestone {
	return &sqlc.Milestone{ID: id, ProcessID: id * 11, Title: "Title", Content: "Content", Date: "2026-11-20"}
}

func (r *handlerRepository) FindMilestone(_ context.Context, id int64) (*sqlc.Milestone, error) {
	r.reads++
	return httpFixture(id), nil
}

func (r *handlerRepository) CreateMilestone(_ context.Context, processID int64, title, content string,
	_ *string, day date.Date,
) (*sqlc.Milestone, error) {
	r.writes++
	return &sqlc.Milestone{ID: 4, ProcessID: processID, Title: title, Content: content, Date: day}, nil
}

func (r *handlerRepository) UpdateMilestone(_ context.Context, row sqlc.Milestone) (*sqlc.Milestone, error) {
	r.writes++
	return &row, nil
}

func (r *handlerRepository) DeleteMilestone(context.Context, int64) error {
	r.writes++
	return nil
}

func (r *handlerRepository) ListMilestones(_ context.Context, _ int64, scope access.ListScope,
	_ int64, _, _ int,
) ([]sqlc.Milestone, error) {
	r.reads++
	r.scope = scope
	return []sqlc.Milestone{}, nil
}

func (*handlerRepository) CountMilestones(context.Context, int64, access.ListScope, int64) (int64, error) {
	return 0, nil
}

func resolveProcess(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 11:
		return access.Owners{ProjectOwner: 9, ProcessOwner: 7}, nil
	case 22:
		return access.Owners{ProjectOwner: 7, ProcessOwner: 8}, nil
	case 33:
		return access.Owners{ProjectOwner: 9, ProcessOwner: 8}, nil
	default:
		return access.Owners{}, errors.ErrNotFound
	}
}

func milestoneActor(scope string) access.UserContext {
	return access.UserContext{ID: 7, Preset: "milestone-" + scope}
}

func installMilestonePolicies(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		engine.SetOwnerProbe(nil)
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	var input engine.PublishInput
	for _, scope := range []string{"process_owner", "project_owner"} {
		for _, action := range []string{"view", "create", "update", "delete"} {
			input.Grants = append(
				input.Grants,
				engine.RuleGrant{Sub: "milestone-" + scope, Key: "milestone/" + action, Scope: scope},
			)
		}
	}
	input.Grants = append(
		input.Grants,
		engine.RuleGrant{Sub: "milestone-inherited", Key: "project/view", Scope: "self"},
	)
	if err := engine.Publish(input); err != nil {
		t.Fatal(err)
	}
	engine.SetOwnerProbe(&engine.OwnerProbe{
		Parents: func(ctx context.Context, _ access.Resource, id int64) ([]engine.Target, error) {
			owners, err := resolveProcess(ctx, id*11)
			if err != nil {
				return nil, err
			}
			return []engine.Target{{Res: access.ResourceProject, ID: 1, Owners: owners}}, nil
		},
	})
}

func milestoneRouter(user access.UserContext, repo *handlerRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{
		ProcessOwners: resolveProcess,
		MilestoneOwners: func(ctx context.Context, id int64) (access.Owners, error) {
			return resolveProcess(ctx, id*11)
		},
	}, rbac.ProvideAll())
	svc := milestone.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewMilestoneHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes shared rules and parent probes.
func TestMilestoneHTTPAccessThroughProcessAndProject(t *testing.T) {
	installMilestonePolicies(t)
	process, project := milestoneActor("process_owner"), milestoneActor("project_owner")
	inherited := milestoneActor("inherited")
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"own process view", "GET", "/1", "", process, 200, 0},
		{"foreign process view", "GET", "/3", "", process, 404, 0},
		{"own project view", "GET", "/2", "", project, 200, 0},
		{"foreign project view", "GET", "/3", "", project, 404, 0},
		{"inherited view", "GET", "/2", "", inherited, 200, 0},
		{"inherited view does not update", "PUT", "/2", `{"title":"New"}`, inherited, 403, 0},
		{"own update", "PUT", "/1", `{"title":"New"}`, process, 200, 1},
		{"foreign update", "PUT", "/3", `{"title":"New"}`, process, 403, 0},
		{"foreign reparent", "PUT", "/1", `{"process_id":33}`, process, 403, 0},
		{"null reparent", "PUT", "/1", `{"process_id":null}`, process, 200, 1},
		{"own create", "POST", "", `{"process_id":11,"title":"T","content":"C","date":"2026-11-20"}`, process, 201, 1},
		{"foreign create", "POST", "", `{"process_id":33,"title":"T","content":"C","date":"2026-11-20"}`, process, 403, 0},
		{"own delete", "DELETE", "/1", "", process, 204, 1},
		{"foreign delete", "DELETE", "/3", "", process, 403, 0},
		{"no access", "GET", "/1", "", access.UserContext{ID: 7}, 404, 0},
		{"admin view", "GET", "/3", "", access.UserContext{ID: 7, Admin: true}, 200, 0},
		{"unknown id", "GET", "/99", "", process, 404, 0},
		{"invalid date", "PUT", "/1", `{"date":"2026-02-30"}`, process, 400, 0},
		{"missing date", "PUT", "/1", `{"date":""}`, process, 400, 0},
		{"invalid color", "PUT", "/1", `{"color":"red"}`, process, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &handlerRepository{}
			router := milestoneRouter(tc.user, repo)
			request := httptest.NewRequest(tc.method, "/api/v1/milestone"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != tc.status || repo.writes != tc.writes {
				t.Fatalf("status=%d writes=%d body=%s", response.Code, repo.writes, response.Body.String())
			}
			if tc.status == http.StatusNotFound && repo.reads != 0 {
				t.Fatal("hidden milestone reached the core repository")
			}
		})
	}
}

//nolint:paralleltest // Publishes shared rules and parent probes.
func TestMilestoneHTTPListScope(t *testing.T) {
	installMilestonePolicies(t)
	for _, tc := range []struct {
		name string
		user access.UserContext
		want access.ListScope
	}{
		{"process", milestoneActor("process_owner"), access.ListScope{ProcessOwner: true}},
		{"project", milestoneActor("project_owner"), access.ListScope{ProjectOwner: true}},
		{"inherited project", milestoneActor("inherited"),
			access.ListScope{ProjectView: []string{"self"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &handlerRepository{}
			response := httptest.NewRecorder()
			milestoneRouter(
				tc.user,
				repo,
			).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/milestone", nil))
			if response.Code != http.StatusOK || repo.reads != 1 || repo.scope.None || repo.scope.All ||
				repo.scope.ProjectOwner != tc.want.ProjectOwner || repo.scope.ProcessOwner != tc.want.ProcessOwner ||
				strings.Join(repo.scope.ProjectView, ",") != strings.Join(tc.want.ProjectView, ",") {
				t.Fatalf("list scope broadened: %+v status=%d", repo.scope, response.Code)
			}
		})
	}
}
