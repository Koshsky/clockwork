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
	resource "github.com/Koshsky/erp-backend/internal/timesheet/resource"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/delivery"
	"github.com/Koshsky/erp-backend/internal/timesheet/resource/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/date"
	errorsapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type resourceAccessRepository struct {
	resource.Repository

	reads, writes int
	row           *sqlc.ListResourcesRow
	scope         access.ListScope
	owner         int64
}

func resourceOwner(_ context.Context, id int64) (access.Owners, error) {
	switch id {
	case 1:
		return access.Owners{Owner: 7}, nil
	case 2:
		return access.Owners{Owner: 8}, nil
	default:
		return access.Owners{}, errorsapi.ErrNotFound
	}
}
func (r *resourceAccessRepository) FindResource(ctx context.Context, id int64) (*sqlc.ListResourcesRow, error) {
	r.reads++
	owner, err := resourceOwner(ctx, id)
	if err != nil {
		return nil, err
	}
	return &sqlc.ListResourcesRow{ID: id, Code: "R", Title: "Original", OwnerID: owner.Owner, EmployeesCount: 4}, nil
}

func (r *resourceAccessRepository) CreateResource(
	_ context.Context,
	code, title string,
	_ *string,
	owner *int64,
) (*sqlc.ListResourcesRow, error) {
	r.writes++
	r.row = &sqlc.ListResourcesRow{ID: 3, Code: code, Title: title, OwnerID: *owner}
	return r.row, nil
}

func (r *resourceAccessRepository) UpdateResource(
	_ context.Context,
	id int64,
	code, title string,
	_ *string,
	owner *int64,
) (*sqlc.ListResourcesRow, error) {
	r.writes++
	r.row = &sqlc.ListResourcesRow{ID: id, Code: code, Title: title, OwnerID: *owner, EmployeesCount: 4}
	return r.row, nil
}
func (r *resourceAccessRepository) DeleteResource(context.Context, int64) error {
	r.writes++
	return nil
}

func (r *resourceAccessRepository) ListResources(
	_ context.Context,
	_ int64,
	scope access.ListScope,
	owner int64,
	_, _ int,
) ([]sqlc.ListResourcesRow, error) {
	r.reads++
	r.scope, r.owner = scope, owner
	return nil, nil
}
func (r *resourceAccessRepository) CountResources(context.Context, int64, access.ListScope, int64) (int64, error) {
	return 0, nil
}

func (r *resourceAccessRepository) ListMembersByResourceID(
	context.Context,
	int64,
) ([]sqlc.ListMembersByResourceIDRow, error) {
	r.reads++
	return nil, nil
}
func (r *resourceAccessRepository) FindUserManager(_ context.Context, id int64) (*int64, error) {
	r.reads++
	if id == 8 {
		return new(int64(7)), nil
	}
	return new(int64(10)), nil
}
func (r *resourceAccessRepository) AddMember(context.Context, int64, int64) error {
	r.writes++
	return nil
}
func (r *resourceAccessRepository) RemoveMember(context.Context, int64, int64) error {
	r.writes++
	return nil
}

func (r *resourceAccessRepository) ListAbsence(
	context.Context,
	int64,
	date.Date,
	date.Date,
) ([]sqlc.ListResourceAbsenceRow, error) {
	r.reads++
	return nil, nil
}

func resourceRouter(user access.UserContext, repo *resourceAccessRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{ResourceOwners: resourceOwner}, rbac.ProvideAll())
	svc := resource.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewResourceHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestResourceHTTPOwnAllNoneAndMemberAccess(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	var grants []engine.RuleGrant
	for _, action := range []string{"view", "create", "update", "delete"} {
		grants = append(
			grants,
			engine.RuleGrant{Sub: "resource-owner", Key: "resource/" + action, Scope: "self"},
			engine.RuleGrant{Sub: "resource-all", Key: "resource/" + action, Scope: "all"},
		)
	}
	if err := engine.Publish(engine.PublishInput{Grants: grants}); err != nil {
		t.Fatal(err)
	}
	own := access.UserContext{ID: 7, Preset: "resource-owner"}
	all := access.UserContext{ID: 7, Preset: "resource-all"}
	none := access.UserContext{ID: 7}
	admin := access.UserContext{ID: 7, Admin: true}
	for _, tc := range []struct {
		name, method, path, body string
		user                     access.UserContext
		status, writes           int
	}{
		{"own read", "GET", "/1", "", own, 200, 0}, {"foreign read hidden", "GET", "/2", "", own, 404, 0}, {"all read", "GET", "/2", "", all, 200, 0}, {"admin read", "GET", "/2", "", admin, 200, 0}, {"none read", "GET", "/1", "", none, 404, 0},
		{"own list", "GET", "", "", own, 200, 0}, {"all filtered list", "GET", "?owner_id=8", "", all, 200, 0}, {"foreign owner filter denied", "GET", "?owner_id=8", "", own, 403, 0}, {"none list", "GET", "", "", none, 403, 0},
		{"own create defaults owner", "POST", "", `{"code":"R","title":"New"}`, own, 201, 1},
		{"own cannot forge owner", "POST", "", `{"code":"R","title":"New","owner_id":8}`, own, 403, 0},
		{"all creates foreign", "POST", "", `{"code":"R","title":"New","owner_id":8}`, all, 201, 1},
		{"none create denied", "POST", "", `{"code":"R","title":"New"}`, none, 403, 0},
		{"own update", "PUT", "/1", `{"title":"Changed"}`, own, 200, 1}, {"foreign update denied", "PUT", "/2", `{"title":"Changed"}`, own, 403, 0}, {"none update denied", "PUT", "/1", `{"title":"Changed"}`, none, 403, 0},
		{"own cannot transfer", "PUT", "/1", `{"owner_id":8}`, own, 403, 0}, {"all transfers owner", "PUT", "/1", `{"owner_id":8}`, all, 200, 1}, {"admin transfers owner", "PUT", "/2", `{"owner_id":9}`, admin, 200, 1},
		{"own delete", "DELETE", "/1", "", own, 204, 1}, {"foreign delete denied", "DELETE", "/2", "", own, 403, 0}, {"all deletes foreign", "DELETE", "/2", "", all, 204, 1}, {"none delete denied", "DELETE", "/1", "", none, 403, 0},
		{"own members", "GET", "/1/members", "", own, 200, 0}, {"foreign members hidden", "GET", "/2/members", "", own, 404, 0}, {"all members", "GET", "/2/members", "", all, 200, 0},
		{"direct subordinate add", "POST", "/1/members", `{"user_id":8}`, own, 204, 1}, {"indirect subordinate denied", "POST", "/1/members", `{"user_id":9}`, own, 403, 0}, {"self add", "POST", "/1/members", `{"user_id":7}`, own, 204, 1},
		{"foreign resource member denied", "POST", "/2/members", `{"user_id":8}`, own, 403, 0}, {"admin any member", "POST", "/2/members", `{"user_id":9}`, admin, 204, 1},
		{"own remove member", "DELETE", "/1/members/8", "", own, 204, 1}, {"foreign remove denied", "DELETE", "/2/members/8", "", own, 403, 0},
		{"own absence", "GET", "/1/absence?start_date=2026-12-31&end_date=2027-01-02", "", own, 200, 0}, {"foreign absence hidden", "GET", "/2/absence?start_date=2026-12-31&end_date=2027-01-02", "", own, 404, 0}, {"invalid absence date", "GET", "/1/absence?start_date=bad&end_date=2027-01-02", "", own, 400, 0},
		{"missing read", "GET", "/99", "", own, 404, 0}, {"missing update", "PUT", "/99", `{"title":"Changed"}`, own, 404, 0}, {"missing delete", "DELETE", "/99", "", own, 404, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &resourceAccessRepository{}
			request := httptest.NewRequest(tc.method, "/api/v1/resources"+tc.path, strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			resourceRouter(tc.user, repo).ServeHTTP(response, request)
			if response.Code != tc.status || repo.writes != tc.writes {
				t.Fatalf(
					"status=%d reads=%d writes=%d body=%s",
					response.Code,
					repo.reads,
					repo.writes,
					response.Body.String(),
				)
			}
			if tc.status == 404 && repo.reads != 0 {
				t.Fatal("hidden resource reached core repository")
			}
			checkResourceResult(t, tc.name, repo)
		})
	}
}
func checkResourceResult(t *testing.T, name string, repo *resourceAccessRepository) {
	t.Helper()
	switch name {
	case "own create defaults owner":
		if repo.row.OwnerID != 7 {
			t.Fatal("creator ownership lost")
		}
	case "all creates foreign", "all transfers owner":
		if repo.row.OwnerID != 8 {
			t.Fatal("all owner selection lost")
		}
	case "admin transfers owner":
		if repo.row.OwnerID != 9 || repo.row.EmployeesCount != 4 {
			t.Fatal("admin transfer/count lost")
		}
	case "own list":
		if !repo.scope.Self {
			t.Fatal("own scope lost")
		}
	case "all filtered list":
		if !repo.scope.All || repo.owner != 8 {
			t.Fatal("all filter lost")
		}
	}
}
