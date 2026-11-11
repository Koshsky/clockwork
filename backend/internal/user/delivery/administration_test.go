//nolint:testpackage // Drives the delivery service seam and verifies its serialized projection.
package delivery

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/user/dto"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

type administrationUsers struct {
	UserService

	users []dto.UserResponse
	scope rbac.ListScope
}

func (s *administrationUsers) ListAllUsers(context.Context) ([]dto.UserResponse, error) {
	return s.users, nil
}

func (s *administrationUsers) ListUsers(
	_ context.Context,
	_ int64,
	scope rbac.ListScope,
	_ string,
	_ int64,
	_ string,
	_, _ int,
) ([]dto.UserResponse, int64, error) {
	s.scope = scope
	return s.users, int64(len(s.users)), nil
}
func (*administrationUsers) NormalizeSearch(s string) (string, error) { return s, nil }

func TestStructureProjection(t *testing.T) {
	t.Parallel()
	for _, empty := range []bool{false, true} {
		t.Run("projection", func(t *testing.T) {
			t.Parallel()
			service := &administrationUsers{
				users: []dto.UserResponse{
					{
						ID:           7,
						Name:         "Employee",
						Username:     "private_login",
						PasswordHash: "private_hash",
						Position:     "Engineer",
					},
				},
			}
			if empty {
				service.users = nil
			}
			handler := &UserHandler{service: service, logger: slog.New(slog.DiscardHandler)}
			router := gin.New()
			router.GET("/structure", handler.ListStructure)
			reply := httptest.NewRecorder()
			router.ServeHTTP(reply, httptest.NewRequest(http.MethodGet, "/structure", nil))
			var body struct {
				Data []map[string]any `json:"data"`
			}
			if err := json.Unmarshal(reply.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if reply.Code != http.StatusOK || body.Data == nil {
				t.Fatalf("invalid response %s", reply.Body.String())
			}
			if empty {
				if len(body.Data) != 0 {
					t.Fatal("expected empty structure")
				}
				return
			}
			assertStructureFields(t, body.Data[0])
		})
	}
}

func TestAccountDirectoryUsesAccountScope(t *testing.T) {
	t.Parallel()
	service := &administrationUsers{}
	handler := &UserHandler{service: service, logger: slog.New(slog.DiscardHandler)}
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, userctx.UserContext{ID: 42, Preset: "worker"}) })
	router.GET("/accounts", handler.ListAccounts)
	reply := httptest.NewRecorder()
	router.ServeHTTP(reply, httptest.NewRequest(http.MethodGet, "/accounts", nil))
	if reply.Code != http.StatusOK || !service.scope.All || service.scope.Self {
		t.Fatalf("account view still depends on subordinate ownership: %d %+v", reply.Code, service.scope)
	}
}

func assertStructureFields(t *testing.T, row map[string]any) {
	t.Helper()
	for _, field := range []string{"username", "password_hash", "hire_date", "termination_date", "created_at"} {
		if _, ok := row[field]; ok {
			t.Errorf("structure exposes %s", field)
		}
	}
	for _, field := range []string{"id", "name", "last_name", "first_name", "middle_name", "manager_id", "position", "preset"} {
		if _, ok := row[field]; !ok {
			t.Errorf("missing structure field %s", field)
		}
	}
}
