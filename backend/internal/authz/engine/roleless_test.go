package engine_test

import (
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

//nolint:paralleltest // Mutates the global policy snapshot.
func TestRolelessPrincipalsDoNotInheritUnrelatedPresets(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	if err := engine.Publish(engine.PublishInput{
		Grants: []engine.RuleGrant{
			{Sub: "worker", Key: "user_catalog/view", Scope: "all"},
			{Sub: "8", Key: "user_catalog/view", Scope: "all"},
			{Sub: "9", Key: "user_catalog/view", Scope: "all"},
		},
		Denies: []engine.RuleDeny{{Sub: "9", Key: "user_catalog/view"}},
		Roles:  []engine.RoleAssign{{User: "13", Preset: "worker"}},
	}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		user access.UserContext
		want string
	}{
		{"no preset", access.UserContext{ID: 7}, engine.ScopeNone},
		{"direct grant without preset", access.UserContext{ID: 8}, engine.ScopeAll},
		{"revoke without preset", access.UserContext{ID: 9}, engine.ScopeNone},
		{"assigned preset", access.UserContext{ID: 10, Preset: "worker"}, engine.ScopeAll},
		{"unknown preset", access.UserContext{ID: 11, Preset: "unknown"}, engine.ScopeNone},
		{"admin without preset", access.UserContext{ID: 12, Admin: true}, engine.ScopeAll},
		{"database assignment", access.UserContext{ID: 13}, engine.ScopeAll},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if scope := engine.ViewScopeCodeUser(tc.user, access.ResourceUserCatalog); scope != tc.want {
				t.Errorf("list scope=%q want=%q", scope, tc.want)
			}
			want := tc.want == engine.ScopeAll
			if allowed := engine.CanUser(tc.user, access.ResourceUserCatalog, engine.ActionView); allowed != want {
				t.Errorf("permission catalog allowed=%v want=%v", allowed, want)
			}
			if allowed := engine.AuthorizeUser(tc.user, access.ResourceUserCatalog, engine.ActionView,
				access.Owners{}, tc.user.ID); allowed != want {
				t.Errorf("authorization allowed=%v want=%v", allowed, want)
			}
		})
	}
	if engine.ViewScopeCode("", access.ResourceUserCatalog) != engine.ScopeNone ||
		engine.Can("", access.ResourceUserCatalog, engine.ActionView) {
		t.Fatal("empty preset matched another preset's rules")
	}
}
