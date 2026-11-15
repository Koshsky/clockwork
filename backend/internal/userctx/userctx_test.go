package userctx_test

import (
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

func TestGetUserPreservesNeutralPrincipal(t *testing.T) {
	t.Parallel()

	want := domain.UserContext{
		ID: 7, Admin: true, Preset: "admin", Email: "user@example.test", FullName: "User", TenantID: 9,
		Rules: []domain.PermissionRule{{Resource: "project", Action: "view", Scope: "self", Granted: true}},
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set("user", want)
	got, err := userctx.GetUser(c)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("GetUser() = %+v, %v; want %+v", got, err, want)
	}
	if id, idErr := userctx.GetUserID(c); idErr != nil || id != want.ID {
		t.Errorf("GetUserID() = %d, %v", id, idErr)
	}
	if preset, presetErr := userctx.GetUserPreset(c); presetErr != nil || preset != want.Preset {
		t.Errorf("GetUserPreset() = %q, %v", preset, presetErr)
	}
	if !userctx.IsAdmin(c) || !userctx.HasPreset(c, "worker", "admin") || userctx.HasPreset(c, "worker") {
		t.Error("principal accessors changed the stored rights")
	}
}

func TestGetUserRejectsMissingOrInvalidPrincipal(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		value any
	}{
		{"missing", nil},
		{"wrong type", "admin"},
		{"principal pointer", &domain.UserContext{ID: 7, Admin: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			if tc.value != nil {
				c.Set(userctx.KeyUser, tc.value)
			}
			if user, err := userctx.GetUser(c); err == nil || user.ID != 0 || user.Admin {
				t.Errorf("GetUser() accepted invalid principal: %+v, %v", user, err)
			}
			assertNoPrincipalRights(t, c)
		})
	}
}

func assertNoPrincipalRights(t *testing.T, c *gin.Context) {
	t.Helper()
	if id, err := userctx.GetUserID(c); err == nil || id != 0 {
		t.Errorf("GetUserID() = %d, %v", id, err)
	}
	if preset, err := userctx.GetUserPreset(c); err == nil || preset != "" {
		t.Errorf("GetUserPreset() = %q, %v", preset, err)
	}
	if userctx.IsAdmin(c) || userctx.HasPreset(c, "admin") {
		t.Error("invalid principal received access")
	}
}
