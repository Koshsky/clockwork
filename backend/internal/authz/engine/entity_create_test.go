package engine_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

//nolint:paralleltest // Publishes grants into the shared policy snapshot.
func TestTaskCreateParentAccess(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{
		{Sub: "3", Key: "task/create", Scope: engine.ScopeParent},
		{Sub: "3", Key: "task/view", Scope: engine.ScopeParent},
		{Sub: "7", Key: "task/create", Scope: engine.ScopeAll},
		{Sub: "7", Key: "task/view", Scope: engine.ScopeParent},
	}, nil, nil)
	policies := taskCreatePolicies(t)
	for _, tc := range []struct {
		name        string
		body        string
		parentOwner int64
		allCreate   bool
		admin       bool
		status      int
	}{
		{"parent in own process", `{"process_id":10,"parent_id":1}`, 3, false, false, http.StatusCreated},
		{"parent in foreign process", `{"process_id":10,"parent_id":1}`, 4, false, false, http.StatusForbidden},
		{"all create cannot bypass parent view", `{"process_id":10,"parent_id":1}`, 4, true, false, http.StatusForbidden},
		{"administrator", `{"process_id":10,"parent_id":1}`, 4, false, true, http.StatusCreated},
		{"top level task", `{"process_id":10}`, 4, false, false, http.StatusCreated},
		{"missing parent", `{"process_id":10,"parent_id":999}`, 3, false, false, http.StatusNotFound},
		{"malformed parent", `{"process_id":10,"parent_id":"1"}`, 3, false, false, http.StatusBadRequest},
		{"another owner in own process", `{"process_id":10,"parent_id":1,"owner_id":4}`, 3, false, false, http.StatusCreated},
	} {
		t.Run(tc.name, func(t *testing.T) {
			userID := int64(3)
			if tc.allCreate {
				userID = 7
			}
			data := rbac.Data{
				ProcessOwners: func(context.Context, int64) (rbac.Owners, error) {
					return rbac.Owners{ProjectOwner: 9, ProcessOwner: 3}, nil
				},
				TaskOwners: func(_ context.Context, id int64) (rbac.Owners, error) {
					if id == 999 {
						return rbac.Owners{}, errors.ErrNotFound
					}
					return rbac.Owners{ProjectOwner: 9, ProcessOwner: tc.parentOwner, Owner: 4}, nil
				},
			}
			middleware := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), data, policies)
			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Set(userctx.KeyUser, userctx.UserContext{
					ID: userID, Preset: userdomain.PresetWorker, Admin: tc.admin,
				})
			})
			router.POST("/task", middleware.Check("task.create"), func(c *gin.Context) { c.Status(http.StatusCreated) })
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/task", strings.NewReader(tc.body)))
			if response.Code != tc.status {
				t.Errorf("status %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
		})
	}
}

func taskCreatePolicies(t *testing.T) []rbac.Policy {
	t.Helper()
	for _, spec := range engine.DefaultRouteSpecs() {
		if spec.Name != "task.create" {
			continue
		}
		policies, err := engine.BuildPolicies([]engine.RouteSpec{spec})
		if err != nil {
			t.Fatal(err)
		}
		return policies
	}
	t.Fatal("task.create policy is missing")
	return nil
}
