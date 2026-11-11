package engine_test

import (
	"context"
	"net/http"
	"net/http/httptest"
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

// commentOwners: comments live in a task of process 2 of project 1; the author —
// by the comment id (comment 42 was written by user 42, 43 — by user 43).
func commentOwners(_ context.Context, id int64) (rbac.Owners, error) {
	if id%10 == 0 {
		return rbac.Owners{}, errors.ErrNotFound
	}
	return rbac.Owners{ProjectOwner: 1, ProcessOwner: 2, Owner: id + 41}, nil
}

func TestDeleteCommentPolicy(t *testing.T) {
	t.Parallel()
	mw := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), rbac.Data{
		TaskOwners: func(_ context.Context, _ int64) (rbac.Owners, error) {
			return rbac.Owners{ProjectOwner: 1, ProcessOwner: 2}, nil
		},
		CommentOwners: commentOwners,
	}, []rbac.Policy{{Name: "task.comment.delete", Check: engine.CommentDeleteCheck()}})

	cases := []struct {
		name       string
		role       string
		userID     int64
		path       string
		wantStatus int
	}{
		{"author deletes own comment", vp, 42, "/task/1/comments/1", http.StatusOK},
		{"vp of own process deletes foreign comment", vp, 2, "/task/1/comments/2", http.StatusOK},
		{"admin deletes any comment", admin, 1, "/task/1/comments/3", http.StatusOK},
		{"rp cannot delete (view only)", rp, 3, "/task/1/comments/4", http.StatusForbidden},
		{"dp cannot delete (no task update)", dp, 5, "/task/1/comments/5", http.StatusForbidden},
		{"unknown comment → 404", admin, 1, "/task/1/comments/10", http.StatusNotFound},
		{"invalid comment id → 400", admin, 1, "/task/1/comments/abc", http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			router := gin.New()
			router.Use(func(c *gin.Context) {
				c.Set(userctx.KeyUser, userctx.UserContext{ID: tc.userID, Preset: tc.role, Admin: tc.role == "admin"})
				c.Next()
			})
			router.DELETE("/task/:id/comments/:comment_id", mw.Check("task.comment.delete"), func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"ok": true})
			})

			req := httptest.NewRequest(http.MethodDelete, tc.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Errorf("%s: got %d, want %d (body: %s)", tc.name, rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}
