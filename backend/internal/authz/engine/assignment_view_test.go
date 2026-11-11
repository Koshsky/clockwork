package engine_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

//nolint:paralleltest,tparallel // Publishes a shared legacy policy; only child cases may run concurrently.
func TestAssignmentViewOwnRequiresTaskAndResource(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{
		{Sub: "3", Key: "assignment/view", Scope: engine.ScopeParent},
		{Sub: "3", Key: "assignment/update", Scope: engine.ScopeParent},
		{Sub: "3", Key: "assignment/delete", Scope: engine.ScopeParent},
	}, nil, nil)
	cases := []struct {
		name          string
		role          string
		taskOwner     int64
		resourceOwner int64
		want          int
	}{
		{"own task and resource", userdomain.PresetProcessOwner, 3, 3, http.StatusOK},
		{"foreign task", userdomain.PresetProcessOwner, 4, 3, http.StatusNotFound},
		{"historical foreign resource", userdomain.PresetProcessOwner, 3, 4, http.StatusNotFound},
		{"missing resource owner", userdomain.PresetProcessOwner, 3, 0, http.StatusNotFound},
		{"all scope", userdomain.PresetProjectDirector, 4, 4, http.StatusOK},
		{"administrator", userdomain.PresetAdmin, 4, 4, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			router := gin.New()
			router.GET("/assignment/:id", func(c *gin.Context) {
				uid := int64(3)
				if tc.role == userdomain.PresetProjectDirector {
					uid = 8
				}
				check := &rbac.CheckCtx{
					C: c,
					User: userctx.UserContext{
						ID: uid, Preset: tc.role, Admin: tc.role == userdomain.PresetAdmin,
					},
					Data: rbac.Data{AssignmentOwners: func(context.Context, int64) (rbac.Owners, error) {
						return rbac.Owners{
							ProjectOwner: 9, ProcessOwner: 3, Owner: tc.taskOwner, ResourceOwner: tc.resourceOwner,
						}, nil
					}},
				}
				err := engine.EntityCheck(rbac.ResourceAssignment, engine.ActionView)(check)
				if err == nil {
					c.Status(http.StatusOK)
					return
				}
				if !errors.IsNotFoundError(err) {
					t.Errorf("expected a concealed entity, got %v", err)
				}
				c.Status(http.StatusNotFound)
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/assignment/1", nil))
			if response.Code != tc.want {
				t.Errorf("status %d, want %d", response.Code, tc.want)
			}
		})
	}
}

//nolint:paralleltest,tparallel // Publishes a shared legacy policy; only child cases may run concurrently.
func TestAssignmentMutationsOwnRequireTaskAndResource(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{
		{Sub: "3", Key: "assignment/view", Scope: engine.ScopeParent},
		{Sub: "3", Key: "assignment/update", Scope: engine.ScopeParent},
		{Sub: "3", Key: "assignment/delete", Scope: engine.ScopeParent},
	}, nil, nil)
	for _, action := range []engine.Action{engine.ActionUpdate, engine.ActionDelete} {
		method := http.MethodPut
		if action == engine.ActionDelete {
			method = http.MethodDelete
		}
		t.Run(engine.ActionName(action), func(t *testing.T) {
			t.Parallel()
			for _, tc := range []struct {
				name          string
				taskOwner     int64
				resourceOwner int64
				admin         bool
				allowed       bool
			}{
				{"own task and resource", 3, 3, false, true},
				{"foreign task", 4, 3, false, false},
				{"historical foreign resource", 3, 4, false, false},
				{"missing resource owner", 3, 0, false, false},
				{"administrator", 4, 4, true, true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					t.Parallel()
					c, _ := gin.CreateTestContext(httptest.NewRecorder())
					c.Request = httptest.NewRequest(method, "/assignment/1", nil)
					c.Params = gin.Params{{Key: "id", Value: "1"}}
					check := &rbac.CheckCtx{
						C:    c,
						User: userctx.UserContext{ID: 3, Preset: userdomain.PresetProcessOwner, Admin: tc.admin},
						Data: rbac.Data{AssignmentOwners: func(context.Context, int64) (rbac.Owners, error) {
							return rbac.Owners{
								ProjectOwner: 9, ProcessOwner: 3, Owner: tc.taskOwner, ResourceOwner: tc.resourceOwner,
							}, nil
						}},
					}
					err := engine.EntityCheck(rbac.ResourceAssignment, action)(check)
					if tc.allowed && err != nil {
						t.Fatalf("own or administrator mutation denied: %v", err)
					}
					if !tc.allowed && !errors.IsForbidden(err) {
						t.Fatalf("foreign assignment mutation must be forbidden, got %v", err)
					}
				})
			}
		})
	}
}
