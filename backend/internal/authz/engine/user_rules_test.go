package engine_test

import (
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
)

// TestScopeForUserOverride verifies the per-user resolution rule:
// admin → all; a per-user override wins over the preset; a revoke beats a
// preset grant; no preset → the override decides; nothing → none.
func TestScopeForUserOverride(t *testing.T) {
	t.Parallel()
	m := engine.DefaultMatrix()

	// Preset-only user: rp views own projects.
	rp := access.UserContext{Preset: userdomain.PresetProjectManager}
	if got := m.ScopeForUser(rp, access.ResourceProject, engine.ActionView); got != engine.ScopeOwn {
		t.Errorf("rp without overrides: got %v; want self", got)
	}

	// Admin bypass wins regardless of rules/overrides.
	adminUser := access.UserContext{
		Preset: userdomain.PresetAdmin,
		Admin:  true,
		Rules:  []access.PermissionRule{{Resource: "project", Action: "view", Granted: false}},
	}
	if got := m.ScopeForUser(adminUser, access.ResourceProject, engine.ActionView); got != engine.ScopeAll {
		t.Errorf("admin bypass: got %v; want all", got)
	}

	// Worker (no preset rights) with an explicit grant override.
	workerGranted := access.UserContext{
		Preset: userdomain.PresetWorker,
		Rules: []access.PermissionRule{
			{Resource: "project", Action: "view", Scope: "all", Granted: true},
		},
	}
	if got := m.ScopeForUser(workerGranted, access.ResourceProject, engine.ActionView); got != engine.ScopeAll {
		t.Errorf("grant override: got %v; want all", got)
	}

	// Revoke beats the preset grant (rp loses project.view).
	rpRevoked := access.UserContext{
		Preset: userdomain.PresetProjectManager,
		Rules: []access.PermissionRule{
			{Resource: "project", Action: "view", Granted: false},
		},
	}
	if got := m.ScopeForUser(rpRevoked, access.ResourceProject, engine.ActionView); got != engine.ScopeNone {
		t.Errorf("revoke override: got %v; want none", got)
	}

	// An unrelated override does not affect the preset rule.
	rpOther := access.UserContext{
		Preset: userdomain.PresetProjectManager,
		Rules: []access.PermissionRule{
			{Resource: "task", Action: "create", Scope: "parent", Granted: true},
		},
	}
	if got := m.ScopeForUser(rpOther, access.ResourceProject, engine.ActionView); got != engine.ScopeOwn {
		t.Errorf("unrelated override: got %v; want self (preset)", got)
	}
}

// publishWithRules publishes the default matrix plus the given user
// grants/denies/role assignments and restores the defaults when the test
// finishes. Mutating the shared snapshot requires the calling test to be
// sequential (no Parallel).
func publishWithRules(t *testing.T, grants []engine.RuleGrant, denies []engine.RuleDeny, roles []engine.RoleAssign) {
	t.Helper()
	t.Cleanup(func() {
		if restoreErr := engine.Publish(engine.DefaultPublishInput()); restoreErr != nil {
			t.Errorf("restore default snapshot: %v", restoreErr)
		}
	})
	input := engine.DefaultPublishInput()
	input.Grants = append(input.Grants, grants...)
	input.Denies = append(input.Denies, denies...)
	input.Roles = append(input.Roles, roles...)
	if err := engine.Publish(input); err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
}

// TestAuthorizeUserWithOverrides verifies the owner-chain check on top of the
// per-user resolution: an own-scope grant matches the row owner, a revoke
// denies even when the preset would allow it.
func TestAuthorizeUserWithOverrides(t *testing.T) { //nolint:paralleltest // общий snapshot движка — не параллельно
	// Sequential: publishes user rules into the shared Casbin snapshot.
	publishWithRules(t,
		[]engine.RuleGrant{{
			Sub: "42", Key: "project/update", Scope: "own",
		}},
		[]engine.RuleDeny{{
			Sub: "42", Key: "project/delete",
		}},
		nil,
	)

	// worker granted project.update (own) — allowed only on own rows.
	workerGranted := access.UserContext{
		ID:     42,
		Preset: userdomain.PresetWorker,
	}
	if !engine.AuthorizeUser(
		workerGranted,
		access.ResourceProject,
		engine.ActionUpdate,
		access.Owners{ProjectOwner: 42},
		42,
	) {
		t.Errorf("own-scope grant: want allowed for the owner")
	}
	if engine.AuthorizeUser(
		workerGranted,
		access.ResourceProject,
		engine.ActionUpdate,
		access.Owners{ProjectOwner: 42},
		7,
	) {
		t.Errorf("own-scope grant: want denied for a foreign user")
	}

	// rp preset allows own project.delete; the revoke must deny entirely.
	rpRevoked := access.UserContext{
		ID:     42,
		Preset: userdomain.PresetProjectManager,
	}
	if engine.AuthorizeUser(
		rpRevoked,
		access.ResourceProject,
		engine.ActionDelete,
		access.Owners{ProjectOwner: 42},
		42,
	) {
		t.Errorf("revoke override: want denied")
	}
}

// TestViewScopeCodeUser mirrors the preset-based listing scope with overrides.
func TestViewScopeCodeUser(t *testing.T) { //nolint:paralleltest // общий snapshot движка — не параллельно
	// Sequential: publishes a user-level revoke and the role assignments.
	publishWithRules(t, nil, []engine.RuleDeny{{
		Sub: "6", Key: "project/view",
	}}, []engine.RoleAssign{
		{User: "5", Preset: userdomain.PresetProjectManager},
		{User: "6", Preset: userdomain.PresetProjectManager},
	})

	rp := access.UserContext{ID: 5, Preset: userdomain.PresetProjectManager}
	if got := engine.ViewScopeCodeUser(rp, access.ResourceProject); got != "self" {
		t.Errorf("rp project view scope: got %q; want self", got)
	}

	rpRevoked := access.UserContext{ID: 6, Preset: userdomain.PresetProjectManager}
	if got := engine.ViewScopeCodeUser(
		rpRevoked,
		access.ResourceProject,
	); got != "" {
		t.Errorf("revoked view scope: got %q; want empty", got)
	}

	adminUser := access.UserContext{Preset: userdomain.PresetAdmin, Admin: true}
	if got := engine.ViewScopeCodeUser(adminUser, access.ResourceProject); got != "all" {
		t.Errorf("admin view scope: got %q; want all", got)
	}
}
