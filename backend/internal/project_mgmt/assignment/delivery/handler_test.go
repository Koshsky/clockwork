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
	assignment "github.com/Koshsky/erp-backend/internal/project_mgmt/assignment"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/delivery"
	"github.com/Koshsky/erp-backend/internal/project_mgmt/assignment/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type accessRepository struct {
	reads, writes int
	user, owner   int64
	scope         access.ListScope
	limit, offset int
}

func assignmentRow(id int64) (*sqlc.Assignment, error) {
	switch id {
	case 1:
		return &sqlc.Assignment{ID: id, TaskID: 11, ResourceID: 21, Quantity: 2}, nil
	case 2:
		return &sqlc.Assignment{ID: id, TaskID: 22, ResourceID: 22, Quantity: 2}, nil
	case 3:
		return &sqlc.Assignment{ID: id, TaskID: 12, ResourceID: 21, Quantity: 2}, nil
	default:
		return nil, errorsapi.ErrNotFound
	}
}

func taskOwners(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 11:
		return access.Owners{ProjectOwner: 9, ProcessOwner: 7, Owner: 7}, nil
	case 12:
		return access.Owners{ProjectOwner: 9, ProcessOwner: 7, Owner: 8}, nil
	case 22:
		return access.Owners{ProjectOwner: 9, ProcessOwner: 8, Owner: 8}, nil
	default:
		return access.Owners{}, errorsapi.ErrNotFound
	}
}

func resourceOwners(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 21:
		return access.Owners{Owner: 7}, nil
	case 22:
		return access.Owners{Owner: 8}, nil
	default:
		return access.Owners{}, errorsapi.ErrNotFound
	}
}

func (r *accessRepository) CreateAssignment(
	_ context.Context,
	task, resource int64,
	quantity int,
) (*sqlc.Assignment, error) {
	r.writes++
	return &sqlc.Assignment{ID: 4, TaskID: task, ResourceID: resource, Quantity: int32(quantity)}, nil
}
func (r *accessRepository) FindAssignment(_ context.Context, id int64) (*sqlc.Assignment, error) {
	r.reads++
	return assignmentRow(id)
}

func (r *accessRepository) UpdateAssignment(
	_ context.Context,
	row sqlc.Assignment,
	quantity int,
) (*sqlc.Assignment, error) {
	r.writes++
	row.Quantity = int32(quantity)
	return &row, nil
}
func (r *accessRepository) DeleteAssignment(context.Context, int64) error { r.writes++; return nil }

func (r *accessRepository) ListAssignments(
	_ context.Context,
	user int64,
	scope access.ListScope,
	owner int64,
	limit, offset int,
) ([]sqlc.Assignment, error) {
	r.reads++
	r.user, r.scope, r.owner, r.limit, r.offset = user, scope, owner, limit, offset
	return nil, nil
}
func (r *accessRepository) CountAssignments(context.Context, int64, access.ListScope, int64) (int64, error) {
	return 0, nil
}

func assignmentRouter(user access.UserContext, repo *accessRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{
		TaskOwners: taskOwners, ResourceOwners: resourceOwners,
		AssignmentOwners: func(ctx context.Context, id int64) (access.Owners, error) {
			row, err := assignmentRow(id)
			if err != nil {
				return access.Owners{}, err
			}
			owners, err := taskOwners(ctx, row.TaskID)
			resource, _ := resourceOwners(ctx, row.ResourceID)
			owners.ResourceOwner = resource.Owner
			return owners, err
		},
	}, rbac.ProvideAll())
	svc := assignment.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewAssignmentHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestAssignmentHTTPAccess(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	grants := []engine.RuleGrant{
		{Sub: "assignment-own", Key: "task/view", Scope: "process_owner"},
		{Sub: "assignment-all", Key: "task/view", Scope: "all"},
	}
	for _, action := range []string{"view", "create", "update", "delete"} {
		grants = append(
			grants,
			engine.RuleGrant{Sub: "assignment-own", Key: "assignment/" + action, Scope: "parent"},
			engine.RuleGrant{Sub: "assignment-all", Key: "assignment/" + action, Scope: "all"},
			engine.RuleGrant{Sub: "assignment-blind", Key: "assignment/" + action, Scope: "all"},
		)
	}
	if err := engine.Publish(engine.PublishInput{Grants: grants}); err != nil {
		t.Fatal(err)
	}
	own := access.UserContext{ID: 7, Preset: "assignment-own"}
	all := access.UserContext{ID: 7, Preset: "assignment-all"}
	admin := access.UserContext{ID: 7, Admin: true}
	denied := access.UserContext{ID: 7}
	blind := access.UserContext{ID: 7, Preset: "assignment-blind"}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"own list", "GET", "?limit=20&offset=40", "", own, 200, 0},
		{"all list", "GET", "?limit=20&offset=40&owner_id=8", "", all, 200, 0},
		{"no access list", "GET", "", "", access.UserContext{ID: 7}, 403, 0},
		{"own list cannot select foreign owner", "GET", "?owner_id=8", "", own, 403, 0},
		{"no access create", "POST", "", `{"task_id":11,"resource_id":21,"quantity":1}`, denied, 403, 0},
		{"no access update", "PUT", "/1", `{"quantity":4}`, denied, 403, 0},
		{"no access delete", "DELETE", "/1", "", denied, 403, 0},
		{"admin common owner", "POST", "", `{"task_id":22,"resource_id":22,"quantity":1}`, admin, 201, 1},
		{"own read", "GET", "/1", "", own, 200, 0},
		{"foreign read", "GET", "/2", "", own, 404, 0},
		{"foreign task in own process read", "GET", "/3", "", own, 404, 0},
		{"all read", "GET", "/2", "", all, 200, 0},
		{"no access read", "GET", "/1", "", access.UserContext{ID: 7}, 404, 0},
		{"own create", "POST", "", `{"task_id":11,"resource_id":21,"quantity":1}`, own, 201, 1},
		{"foreign task create", "POST", "", `{"task_id":12,"resource_id":21,"quantity":1}`, own, 403, 0},
		{"foreign resource create", "POST", "", `{"task_id":11,"resource_id":22,"quantity":1}`, own, 403, 0},
		{"all create common owner", "POST", "", `{"task_id":22,"resource_id":22,"quantity":1}`, all, 201, 1},
		{"all mismatched owners", "POST", "", `{"task_id":11,"resource_id":22,"quantity":1}`, all, 403, 0},
		{"admin mismatched owners", "POST", "", `{"task_id":11,"resource_id":22,"quantity":1}`, admin, 403, 0},
		{"blind create", "POST", "", `{"task_id":11,"resource_id":21,"quantity":1}`, blind, 403, 0},
		{"invalid quantity", "POST", "", `{"task_id":11,"resource_id":21,"quantity":0}`, own, 400, 0},
		{"own update", "PUT", "/1", `{"quantity":4}`, own, 200, 1},
		{"foreign update", "PUT", "/2", `{"quantity":4}`, own, 403, 0},
		{"foreign task in own process update", "PUT", "/3", `{"quantity":4}`, own, 403, 0},
		{"escape to foreign task", "PUT", "/1", `{"task_id":12}`, own, 403, 0},
		{"escape to foreign resource", "PUT", "/1", `{"resource_id":22}`, own, 403, 0},
		{"all update", "PUT", "/2", `{"quantity":4}`, all, 200, 1},
		{"own delete", "DELETE", "/1", "", own, 204, 1},
		{"foreign delete", "DELETE", "/2", "", own, 403, 0},
		{"foreign task in own process delete", "DELETE", "/3", "", own, 403, 0},
		{"all delete", "DELETE", "/2", "", all, 204, 1},
		{"missing read", "GET", "/99", "", own, 404, 0},
		{"missing update", "PUT", "/99", `{"quantity":4}`, own, 404, 0},
		{"missing delete", "DELETE", "/99", "", own, 404, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &accessRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/assignment"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			assignmentRouter(tc.user, repo).ServeHTTP(response, request)
			if response.Code != tc.status || repo.writes != tc.writes {
				t.Fatalf(
					"status=%d reads=%d writes=%d body=%s",
					response.Code,
					repo.reads,
					repo.writes,
					response.Body.String(),
				)
			}
			if strings.Contains(tc.name, "list") && tc.status == 200 {
				checkListScope(t, repo, tc.user)
			}
			if (tc.status == 403 || tc.status == 404) && repo.reads != 0 {
				t.Fatal("denied target reached core repository")
			}
		})
	}
}

func checkListScope(t *testing.T, repo *accessRepository, user access.UserContext) {
	t.Helper()
	if repo.user != 7 || repo.limit != 20 || repo.offset != 40 {
		t.Fatalf("list pagination changed: %+v", repo)
	}
	if user.Preset == "assignment-own" && !repo.scope.Parent {
		t.Fatalf("own list lost scope: %+v", repo.scope)
	}
	if user.Preset == "assignment-all" && (!repo.scope.All || repo.owner != 8) {
		t.Fatalf("all list lost scope/filter: %+v", repo)
	}
}
