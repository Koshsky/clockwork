package auth_test

import (
	"context"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/auth"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

type viewResolver struct{ admin bool }

func (r viewResolver) EffectiveUser(_ context.Context, id int64) (userctx.UserContext, error) {
	return userctx.UserContext{ID: id, Admin: r.admin && id == 1, Preset: "worker"}, nil
}
func TestViewAsReadOnly(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		admin                bool
		method, path, target string
		status               int
	}{
		{true, "GET", "/api/v1/planning/tasks", "7", 200},
		{false, "GET", "/api/v1/planning/tasks", "7", 403},
		{true, "PUT", "/api/v1/planning/tasks", "7", 403},
		{true, "GET", "/api/v1/user/7", "7", 403},
		{true, "GET", "/api/v1/planning/tasks", "-1", 403},
	} {
		t.Run(fmt.Sprintf("%s/%s/%s/%t", tc.method, tc.path, tc.target, tc.admin), func(t *testing.T) {
			t.Parallel()
			jwt := newJWT("test-secret", "test", time.Hour)
			mw := auth.ProvideAuthMiddleware(
				slog.New(slog.DiscardHandler),
				jwt,
				viewResolver{tc.admin},
			)
			router := gin.New()
			router.Use(mw.RequireAuth())
			router.Handle(tc.method, tc.path, func(c *gin.Context) {
				user, _ := userctx.GetUser(c)
				if user.ID != 7 || user.Admin {
					t.Error("wrong subject")
				}
				c.Status(200)
			})
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Authorization", bearerToken(t, jwt, 1, "test@example.com"))
			req.Header.Set("X-View-User-Id", tc.target)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("status %d want %d", w.Code, tc.status)
			}
		})
	}
}
