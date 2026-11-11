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
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// parentActionRouter builds a gin router protected by the named default route
// policy (parent_action kind) with the given owner resolvers injected; the
// authenticated user is role/userID.
func parentActionRouter(policyName string, data rbac.Data, role string, userID int64) *gin.Engine {
	spec := engine.DefaultRouteSpecs()
	var route engine.RouteSpec
	for _, s := range spec {
		if s.Name == policyName {
			route = s
			break
		}
	}
	if route.Name == "" {
		panic("policies: default route spec not found: " + policyName)
	}
	built, err := engine.BuildPolicies([]engine.RouteSpec{route})
	if err != nil || len(built) != 1 {
		panic("policies: build parent_action spec: " + err.Error())
	}
	mw := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), data, built)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(userctx.KeyUser, userctx.UserContext{ID: userID, Preset: role, Admin: role == "admin"})
		c.Next()
	})
	router.PUT("/order", mw.Check(policyName), func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})
	return router
}

// TestParentActionTaskOrder: /task/order is authorized by the process owner
// chain from body process_id (matrix: task.update, vp — parent scope).
func TestParentActionTaskOrder(t *testing.T) {
	t.Parallel()
	data := rbac.Data{
		ProcessOwners: func(_ context.Context, id int64) (rbac.Owners, error) {
			if id == 0 {
				return rbac.Owners{}, errors.ErrNotFound
			}
			return processOfVP1, nil
		},
	}
	policyName := "task.order"

	cases := []struct {
		name       string
		role       string
		userID     int64
		body       string
		wantStatus int
	}{
		{"vp of own process reorders tasks", vp, uVP1, `{"process_id":5,"ids":[1,2]}`, http.StatusNoContent},
		{"admin reorders any process tasks", admin, uAdmin, `{"process_id":5,"ids":[1,2]}`, http.StatusNoContent},
		{"vp of another process cannot reorder", vp, uVP2, `{"process_id":5,"ids":[1,2]}`, http.StatusForbidden},
		{"rp reorders own project tasks", rp, uRP, `{"process_id":5,"ids":[1,2]}`, http.StatusNoContent},
		{"dp cannot reorder (no task update)", dp, uDP, `{"process_id":5,"ids":[1,2]}`, http.StatusForbidden},
		{"unknown process → 404", admin, uAdmin, `{"process_id":0,"ids":[1,2]}`, http.StatusNotFound},
		{"malformed body → 400", admin, uAdmin, `{"process_id":`, http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			router := parentActionRouter(policyName, data, tc.role, tc.userID)
			req := httptest.NewRequest(http.MethodPut, "/order", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("%s: got %d, want %d (body: %s)", tc.name, rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

// TestParentActionProcessOrder: /process/order is authorized by the project
// owner chain from body project_id (matrix: process.update, rp — parent scope).
func TestParentActionProcessOrder(t *testing.T) {
	t.Parallel()
	data := rbac.Data{
		ProjectOwners: func(_ context.Context, id int64) (rbac.Owners, error) {
			if id == 0 {
				return rbac.Owners{}, errors.ErrNotFound
			}
			return projectOfRP, nil
		},
	}
	policyName := "process.order"

	cases := []struct {
		name       string
		role       string
		userID     int64
		body       string
		wantStatus int
	}{
		{"rp of own project reorders processes", rp, uRP, `{"project_id":3,"ids":[1,2]}`, http.StatusNoContent},
		{"admin reorders any project processes", admin, uAdmin, `{"project_id":3,"ids":[1,2]}`, http.StatusNoContent},
		{"vp cannot reorder processes", vp, uVP1, `{"project_id":3,"ids":[1,2]}`, http.StatusForbidden},
		{"dp cannot reorder processes", dp, uDP, `{"project_id":3,"ids":[1,2]}`, http.StatusForbidden},
		{"malformed body → 400", admin, uAdmin, `{"project_id":`, http.StatusBadRequest},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			router := parentActionRouter(policyName, data, tc.role, tc.userID)
			req := httptest.NewRequest(http.MethodPut, "/order", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("%s: got %d, want %d (body: %s)", tc.name, rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}
