//nolint:paralleltest // Capability checks publish and restore the shared engine snapshot.
package engine_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

func TestAdministrationCapabilityIsolation(
	t *testing.T,
) { //nolint:paralleltest // Publishes a shared authorization snapshot.
	routes := map[string][]string{
		"rbac.manage":       {"rbac_config/update"},
		"autocreate.list":   {"auto_create/view", "auto_create/update"},
		"autocreate.update": {"auto_create/update"},
		"user.accounts":     {"user_admin/view", "rbac_config/update"},
		"user.structure":    {"org_structure/view"},
		"user.picker":       {"user_catalog/view"},
		"state.list":        {"state/view"},
		"state.create":      {"state/create"},
		"state.update":      {"state/update"},
		"state.delete":      {"state/delete"},
		"audit.view":        {"audit/view"},
	}
	keys := []string{"", "rbac_config/update", "auto_create/view", "auto_create/update",
		"user_admin/view", "user_admin/update", "org_structure/view", "user_catalog/view",
		"worker/view", "worker/update", "state/view", "state/create", "state/update", "state/delete", "audit/view"}
	for name, allowed := range routes {
		for _, key := range keys {
			for _, mode := range []string{"grant", "revoke", "admin"} {
				t.Run(name+"/"+key+"/"+mode, func(t *testing.T) {
					checkAdministrationCapability(t, name, key, mode, allowed)
				})
			}
		}
	}
}

func checkAdministrationCapability(t *testing.T, name, key, mode string, allowed []string) {
	t.Helper()
	var grants []engine.RuleGrant
	var denies []engine.RuleDeny
	if key != "" {
		grants = append(grants, engine.RuleGrant{Sub: "42", Key: key, Scope: "all"})
		if mode != "grant" {
			denies = append(denies, engine.RuleDeny{Sub: "42", Key: key})
		}
	}
	publishWithRules(t, grants, denies, nil)
	var spec engine.RouteSpec
	for _, candidate := range engine.DefaultRouteSpecs() {
		if candidate.Name == name {
			spec = candidate
		}
	}
	built, err := engine.BuildPolicies([]engine.RouteSpec{spec})
	if err != nil {
		t.Fatal(err)
	}
	mw := rbac.ProvideMiddleware(nil, tracingpkg.New(nil), rbac.Data{}, built)
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(userctx.KeyUser, userctx.UserContext{ID: 42, Preset: "worker", Admin: mode == "admin"})
	})
	router.GET("/check", mw.Check(name), func(c *gin.Context) { c.Status(http.StatusNoContent) })
	reply := httptest.NewRecorder()
	router.ServeHTTP(reply, httptest.NewRequest(http.MethodGet, "/check", nil))
	want := http.StatusForbidden
	if spec.Kind == "entity" && spec.Params["action"] == "view" {
		want = http.StatusNotFound
	}
	if mode == "admin" || (mode == "grant" && slices.Contains(allowed, key)) {
		want = http.StatusNoContent
	}
	if reply.Code != want {
		t.Fatalf("status %d, want %d", reply.Code, want)
	}
}

func TestGlobalCapabilityValidation(t *testing.T) {
	t.Parallel()
	for _, value := range []any{nil, "user_admin/view", []any{12}, []string{},
		[]string{""}, []string{"invalid/view"}, []string{"user_admin/invalid"},
		[]string{"user_admin/view/extra"}, []string{"project/view"}, []string{"worker/view"},
		[]string{"state_admin/view"}, []string{"rbac_config/view"}, []string{"audit/update"}} {
		t.Run("invalid", func(t *testing.T) {
			t.Parallel()
			spec := engine.RouteSpec{Name: "test", Kind: "any_capability", Params: map[string]any{"permissions": value}}
			if err := engine.ValidateSpec(spec); err == nil {
				t.Fatalf("accepted invalid global capabilities: %v", value)
			}
		})
	}
}

func TestAdministrationActionCatalog(t *testing.T) {
	t.Parallel()
	for name, actions := range map[string][]engine.Action{
		"rbac_config":   {engine.ActionUpdate},
		"auto_create":   {engine.ActionView, engine.ActionUpdate},
		"user_catalog":  {engine.ActionView},
		"org_structure": {engine.ActionView},
		"audit":         {engine.ActionView},
		"state_admin":   {},
	} {
		resource, _ := engine.ParseResource(name)
		for action := engine.ActionView; action <= engine.ActionPrioritize; action++ {
			if got := engine.ActionApplicable(resource, action); got != slices.Contains(actions, action) {
				t.Errorf("%s/%s applicability %v", engine.ResourceName(resource), engine.ActionName(action), got)
			}
		}
	}
}
