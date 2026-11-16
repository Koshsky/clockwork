package rbac_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestProjectUpdatePreservesHTTPFieldAuthorization(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{
		{Sub: "42", Key: "project/prioritize", Scope: engine.ScopeAll},
		{Sub: "43", Key: "project/update", Scope: engine.ScopeAll},
		{Sub: "44", Key: "project/prioritize", Scope: engine.ScopeAll},
		{Sub: "44", Key: "project/update", Scope: engine.ScopeAll},
	}, nil, []engine.RoleAssign{
		{User: "42", Preset: "worker"},
		{User: "43", Preset: "worker"},
		{User: "44", Preset: "worker"},
	})
	for _, tc := range []struct {
		name, body, id string
		userID         int64
		status         int
	}{
		{"priority only", `{"priority":2}`, "1", 42, http.StatusNoContent},
		{"priority case alias", `{"PRIORITY":2}`, "1", 42, http.StatusNoContent},
		{"metadata requires update", `{"title":"new"}`, "1", 42, http.StatusForbidden},
		{"mixed requires both", `{"priority":2,"title":"new"}`, "1", 42, http.StatusForbidden},
		{"empty patch requires update", `{}`, "1", 42, http.StatusForbidden},
		{"null body", `null`, "1", 42, http.StatusBadRequest},
		{"array body", `[]`, "1", 42, http.StatusBadRequest},
		{"malformed JSON", `{"priority":`, "1", 42, http.StatusBadRequest},
		{"owner alias", `{"owner_id":44,"OWNER_ID":9}`, "1", 44, http.StatusBadRequest},
		{"invalid owner type", `{"priority":2,"owner_id":"9"}`, "1", 44, http.StatusBadRequest},
		{"update cannot prioritize", `{"priority":2}`, "1", 43, http.StatusForbidden},
		{"metadata only", `{"title":"new"}`, "1", 43, http.StatusNoContent},
		{"mixed with both grants", `{"priority":2,"title":"new"}`, "1", 44, http.StatusNoContent},
		{"invalid path ID", `{"title":"new"}`, "bad", 44, http.StatusBadRequest},
		{"no principal", `{"priority":2}`, "1", 0, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertProjectUpdate(t, tc.body, tc.id, tc.userID, tc.status)
		})
	}
}

func assertProjectUpdate(t *testing.T, body, id string, userID int64, status int) {
	t.Helper()
	data := rbac.Data{ProjectOwners: func(context.Context, int64) (access.Owners, error) {
		return access.Owners{ProjectOwner: 9}, nil
	}}
	middleware := rbac.ProvideMiddleware(slog.New(slog.DiscardHandler), tracing.New(nil), data, rbac.ProvideAll())
	router := gin.New()
	router.Use(func(c *gin.Context) {
		if userID != 0 {
			c.Set("user", access.UserContext{ID: userID, Preset: "worker"})
		}
	})
	ran := false
	router.PUT("/project/:id", middleware.Check("project.update"), func(c *gin.Context) {
		ran = true
		forwarded, err := io.ReadAll(c.Request.Body)
		if err != nil || string(forwarded) != body {
			t.Fatal("authorization changed the handler's request body")
		}
		c.Status(http.StatusNoContent)
	})
	reply := httptest.NewRecorder()
	router.ServeHTTP(reply, httptest.NewRequest(http.MethodPut, "/project/"+id, strings.NewReader(body)))
	if reply.Code != status || ran != (status == http.StatusNoContent) {
		t.Fatalf("status=%d handler=%v, want status=%d: %s", reply.Code, ran, status, reply.Body.String())
	}
	if !ran {
		assertPolicyErrorCode(t, reply, status)
	}
}

func assertPolicyErrorCode(t *testing.T, reply *httptest.ResponseRecorder, status int) {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(reply.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	want := map[int]errors.Code{
		http.StatusBadRequest:   errors.CodeBadRequest,
		http.StatusForbidden:    errors.CodeForbidden,
		http.StatusUnauthorized: errors.CodeUnauthorized,
	}[status]
	if envelope.Error.Code != want.String() {
		t.Fatalf("error code=%s, want %s", envelope.Error.Code, want)
	}
}
