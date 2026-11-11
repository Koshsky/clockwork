package engine_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// TestScopeForUserOverride verifies the per-user resolution rule:
// admin → all; a per-user override wins over the preset; a revoke beats a
// preset grant; no preset → the override decides; nothing → none.
func TestScopeForUserOverride(t *testing.T) {
	t.Parallel()
	m := engine.DefaultMatrix()

	// Preset-only user: rp views own projects.
	rp := userctx.UserContext{Preset: userdomain.PresetProjectManager}
	if got := m.ScopeForUser(rp, rbac.ResourceProject, engine.ActionView); got != engine.ScopeOwn {
		t.Errorf("rp without overrides: got %v; want self", got)
	}

	// Admin bypass wins regardless of rules/overrides.
	adminUser := userctx.UserContext{
		Preset: userdomain.PresetAdmin,
		Admin:  true,
		Rules:  []userctx.PermissionRule{{Resource: "project", Action: "view", Granted: false}},
	}
	if got := m.ScopeForUser(adminUser, rbac.ResourceProject, engine.ActionView); got != engine.ScopeAll {
		t.Errorf("admin bypass: got %v; want all", got)
	}

	// Worker (no preset rights) with an explicit grant override.
	workerGranted := userctx.UserContext{
		Preset: userdomain.PresetWorker,
		Rules: []userctx.PermissionRule{
			{Resource: "project", Action: "view", Scope: "all", Granted: true},
		},
	}
	if got := m.ScopeForUser(workerGranted, rbac.ResourceProject, engine.ActionView); got != engine.ScopeAll {
		t.Errorf("grant override: got %v; want all", got)
	}

	// Revoke beats the preset grant (rp loses project.view).
	rpRevoked := userctx.UserContext{
		Preset: userdomain.PresetProjectManager,
		Rules: []userctx.PermissionRule{
			{Resource: "project", Action: "view", Granted: false},
		},
	}
	if got := m.ScopeForUser(rpRevoked, rbac.ResourceProject, engine.ActionView); got != engine.ScopeNone {
		t.Errorf("revoke override: got %v; want none", got)
	}

	// An unrelated override does not affect the preset rule.
	rpOther := userctx.UserContext{
		Preset: userdomain.PresetProjectManager,
		Rules: []userctx.PermissionRule{
			{Resource: "task", Action: "create", Scope: "parent", Granted: true},
		},
	}
	if got := m.ScopeForUser(rpOther, rbac.ResourceProject, engine.ActionView); got != engine.ScopeOwn {
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
	workerGranted := userctx.UserContext{
		ID:     42,
		Preset: userdomain.PresetWorker,
	}
	if !engine.AuthorizeUser(
		workerGranted,
		rbac.ResourceProject,
		engine.ActionUpdate,
		rbac.Owners{ProjectOwner: 42},
		42,
	) {
		t.Errorf("own-scope grant: want allowed for the owner")
	}
	if engine.AuthorizeUser(
		workerGranted,
		rbac.ResourceProject,
		engine.ActionUpdate,
		rbac.Owners{ProjectOwner: 42},
		7,
	) {
		t.Errorf("own-scope grant: want denied for a foreign user")
	}

	// rp preset allows own project.delete; the revoke must deny entirely.
	rpRevoked := userctx.UserContext{
		ID:     42,
		Preset: userdomain.PresetProjectManager,
	}
	if engine.AuthorizeUser(
		rpRevoked,
		rbac.ResourceProject,
		engine.ActionDelete,
		rbac.Owners{ProjectOwner: 42},
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

	rp := userctx.UserContext{ID: 5, Preset: userdomain.PresetProjectManager}
	if got := engine.ViewScopeCodeUser(rp, rbac.ResourceProject); got != "self" {
		t.Errorf("rp project view scope: got %q; want self", got)
	}

	rpRevoked := userctx.UserContext{ID: 6, Preset: userdomain.PresetProjectManager}
	if got := engine.ViewScopeCodeUser(
		rpRevoked,
		rbac.ResourceProject,
	); got != "" {
		t.Errorf("revoked view scope: got %q; want empty", got)
	}

	adminUser := userctx.UserContext{Preset: userdomain.PresetAdmin, Admin: true}
	if got := engine.ViewScopeCodeUser(adminUser, rbac.ResourceProject); got != "all" {
		t.Errorf("admin view scope: got %q; want all", got)
	}
}
