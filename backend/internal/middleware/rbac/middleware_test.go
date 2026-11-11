package rbac_test

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

//nolint:gochecknoinits // gin test mode
func init() {
	gin.SetMode(gin.TestMode)
}

const (
	testAdmin = "admin"
	testRP    = "rp"
	testVP    = "vp"
)

// setUser mimics AuthMiddleware: puts the user into the gin context.
func setUser(role string, id int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(userctx.KeyUser, userctx.UserContext{ID: id, Preset: role, Admin: role == "admin"})
		c.Next()
	}
}

// chainOwners is a "chain" resolver: task/process → {Project:1, Process:2}.
func chainOwners(_ context.Context, id int64) (rbac.Owners, error) {
	if id%10 == 0 {
		return rbac.Owners{}, errors.ErrNotFound
	}
	return rbac.Owners{ProjectOwner: 1, ProcessOwner: 2}, nil
}

// rowOwner is a "row owner" resolver: resource/worker → owner=id.
func rowOwner(_ context.Context, id int64) (rbac.Owners, error) {
	if id%10 == 0 {
		return rbac.Owners{}, errors.ErrNotFound
	}
	return rbac.Owners{Owner: id}, nil
}

func testData() rbac.Data {
	return rbac.Data{
		ProjectOwners:    chainOwners,
		ProcessOwners:    chainOwners,
		TaskOwners:       chainOwners,
		MilestoneOwners:  chainOwners,
		AssignmentOwners: chainOwners,
		ResourceOwners:   rowOwner,
		WorkerOwners:     rowOwner,
	}
}

func TestCheckEntity(t *testing.T) {
	t.Parallel()
	mw := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), testData(), []rbac.Policy{
		{Name: "task.view", Check: engine.EntityCheck(rbac.ResourceTask, engine.ActionView)},
		{Name: "task.update", Check: engine.EntityCheck(rbac.ResourceTask, engine.ActionUpdate)},
	})

	cases := []struct {
		name       string
		role       string
		path       string
		policy     string
		withUser   bool
		wantStatus int
	}{
		{"no user → 401", "", "/1", "task.view", false, http.StatusUnauthorized},
		{"bad id → 400", testAdmin, "/abc", "task.view", true, http.StatusBadRequest},
		{"not found → 404", testAdmin, "/10", "task.view", true, http.StatusNotFound},
		// rp (id 2) — owner of the task's process (owners {Project:1, Process:2}):
		// ancestor = any owner up the chain → access is granted.
		{"RP process ownership alone is insufficient", testRP, "/1", "task.view", true, http.StatusNotFound},
		{"rp update → 403 (view-only)", testRP, "/1", "task.update", true, http.StatusForbidden},
		{"vp views own process → 200", testVP, "/1", "task.view", true, http.StatusOK},
		{"vp updates own → 200", testVP, "/1", "task.update", true, http.StatusOK},
		{"admin view → 200", testAdmin, "/1", "task.view", true, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			router := gin.New()
			if tc.withUser {
				router.Use(setUser(tc.role, 2))
			}
			router.GET("/task/:id", mw.Check(tc.policy), func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"ok": true})
			})

			req := httptest.NewRequest(http.MethodGet, "/task"+tc.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("GET %s: got %d, want %d (body: %s)", tc.path, rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

func TestCheckAssignmentCreate(t *testing.T) {
	t.Parallel()
	mw := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), testData(), []rbac.Policy{
		{Name: "assignment.create", Check: createAssignmentForTest},
	})

	cases := []struct {
		name       string
		role       string
		userID     int64
		body       string
		wantStatus int
	}{
		// vp (id 2) — owner of the task's process (owners {Project:1, Process:2}).
		{
			"vp: task and resource share the owner",
			testVP,
			2,
			`{"task_id":1,"resource_id":2,"quantity":1}`,
			http.StatusCreated,
		},
		{"vp: foreign resource → 403", testVP, 2, `{"task_id":1,"resource_id":5,"quantity":1}`, http.StatusForbidden},
		// admin — full access (ScopeAll), the owners business rule does not apply.
		{
			"admin: foreign resource → 201",
			testAdmin,
			1,
			`{"task_id":1,"resource_id":5,"quantity":1}`,
			http.StatusCreated,
		},
		{
			"admin: unowned resource → 201",
			testAdmin,
			1,
			`{"task_id":1,"resource_id":7,"quantity":1}`,
			http.StatusCreated,
		},
		{"missing task → 404", testVP, 2, `{"task_id":10,"resource_id":2,"quantity":1}`, http.StatusNotFound},
		{"malformed body → 400", testVP, 2, `not-json`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			router := gin.New()
			router.Use(setUser(tc.role, tc.userID))
			router.POST("/assignment", mw.Check("assignment.create"), func(c *gin.Context) {
				c.JSON(http.StatusCreated, gin.H{"ok": true})
			})

			req := httptest.NewRequest(http.MethodPost, "/assignment", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("%s: got %d, want %d (body: %s)", tc.name, rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

// createAssignmentForTest mirrors the engine owner_match rule: the matrix check
// by the task plus the shared-owner business rule (admin exempt).
func createAssignmentForTest(rc *rbac.CheckCtx) error {
	taskID, err := rc.BodyID("task_id")
	if err != nil {
		return err
	}
	resourceID, err := rc.BodyID("resource_id")
	if err != nil {
		return err
	}

	taskOwners, err := rc.Owners(rbac.ResourceTask, taskID)
	if err != nil {
		return err
	}
	if !engine.AuthorizeUser(rc.User, rbac.ResourceAssignment, engine.ActionCreate, taskOwners, rc.User.ID) {
		return errors.ErrForbidden
	}

	if rc.User.Preset != testAdmin {
		resourceOwners, ownerErr := rc.Owners(rbac.ResourceResource, resourceID)
		if ownerErr != nil {
			return ownerErr
		}
		if !taskOwners.SharesOwner(resourceOwners) {
			return errors.ErrForbidden
		}
	}
	return nil
}
