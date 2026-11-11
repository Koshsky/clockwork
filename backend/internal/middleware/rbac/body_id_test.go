package rbac_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

func TestBodyIDRejectsCaseAliases(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		body   string
		status int
		id     int64
	}{
		{`{"owner_id":7}`, http.StatusNoContent, 7},
		{`{"owner_id":7,"owner_id":8}`, http.StatusNoContent, 8},
		{`{"OWNER_ID":8}`, http.StatusBadRequest, 0},
		{`{"owner_id":7,"OWNER_ID":8}`, http.StatusBadRequest, 0},
		{`{"OWNER_ID":8,"owner_id":7}`, http.StatusBadRequest, 0},
		{`{"owner_id":"8"}`, http.StatusBadRequest, 0},
	} {
		t.Run(tc.body, func(t *testing.T) {
			t.Parallel()
			mw := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), rbac.Data{}, []rbac.Policy{{
				Name: "body_id", Check: func(rc *rbac.CheckCtx) error {
					id, err := rc.BodyID("owner_id")
					if err == nil && id != tc.id {
						t.Errorf("ID=%d, want %d", id, tc.id)
					}
					return err
				},
			}})
			router := gin.New()
			router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, userctx.UserContext{ID: 7}) })
			router.PUT("/entity", mw.Check("body_id"), func(c *gin.Context) { c.Status(http.StatusNoContent) })
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/entity", strings.NewReader(tc.body)))
			if response.Code != tc.status {
				t.Fatalf("status=%d, want %d", response.Code, tc.status)
			}
		})
	}
}
