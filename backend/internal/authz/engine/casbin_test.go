package engine_test

import (
	"strconv"
	"sync"
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// userByPreset — test users for the golden equivalence check (uid, preset).
func userByPreset() map[string][2]string {
	return map[string][2]string{
		userdomain.PresetProjectDirector: {"1", userdomain.PresetProjectDirector},
		userdomain.PresetProjectManager:  {"2", userdomain.PresetProjectManager},
		userdomain.PresetProcessOwner:    {"3", userdomain.PresetProcessOwner},
		userdomain.PresetWorker:          {"4", userdomain.PresetWorker},
	}
}

// ownerSample — an (resource, action, owner chain) probe for the golden check.
// The acting user is the role's own uid (the subject id must match the role
// assignment, exactly as in production).
type ownerSample struct {
	res rbac.Resource
	act engine.Action
	own rbac.Owners
}

// TestCasbinGoldenScope checks that the Casbin-backed decisions (ScopeForUser /
// AuthorizeUser / ViewScopeCodeUser) agree with the data-level matrix for
// every (preset, resource, action) and a sample of owner chains.
func TestCasbinGoldenScope(t *testing.T) { //nolint:paralleltest // общий snapshot движка — не параллельно
	// Sequential: publishes role assignments into the shared snapshot.
	publishWithRules(t, nil, nil, []engine.RoleAssign{
		{User: "1", Preset: userdomain.PresetProjectDirector},
		{User: "2", Preset: userdomain.PresetProjectManager},
		{User: "3", Preset: userdomain.PresetProcessOwner},
		{User: "4", Preset: userdomain.PresetWorker},
	})

	m := engine.DefaultMatrix()
	samples := []ownerSample{
		{rbac.ResourceProject, engine.ActionView, rbac.Owners{ProjectOwner: 2}},
		{rbac.ResourceProject, engine.ActionView, rbac.Owners{ProjectOwner: 9}},
		{rbac.ResourceTask, engine.ActionView, rbac.Owners{ProjectOwner: 2, ProcessOwner: 3}},
		{rbac.ResourceTask, engine.ActionView, rbac.Owners{ProjectOwner: 8, ProcessOwner: 9}},
		{rbac.ResourceProcess, engine.ActionUpdate, rbac.Owners{ProjectOwner: 2, ProcessOwner: 1}},
		{rbac.ResourceResource, engine.ActionCreate, rbac.Owners{Owner: 3}},
		{rbac.ResourceWorker, engine.ActionView, rbac.Owners{Owner: 3}},
		{rbac.ResourceState, engine.ActionView, rbac.Owners{}},
	}
	for _, ids := range userByPreset() {
		uid := parseUID(t, ids[0])
		u := userctx.UserContext{ID: uid, Preset: ids[1]}
		for _, s := range samples {
			want := m.ScopeForUser(u, s.res, s.act)
			if got := engine.ScopeForUser(u, s.res, s.act); got != want {
				t.Errorf("preset %s: ScopeForUser(%s, %s) = %v, want %v (data matrix)",
					ids[1], engine.ResourceName(s.res), engine.ActionName(s.act), got, want)
			}
			wantAuth := authorizeFromMatrix(m, u, s)
			if got := engine.AuthorizeUser(u, s.res, s.act, s.own, uid); got != wantAuth {
				t.Errorf("preset %s: AuthorizeUser(%s, %s) = %v, want %v",
					ids[1], engine.ResourceName(s.res), engine.ActionName(s.act), got, wantAuth)
			}
		}
	}
	for _, ids := range userByPreset() {
		u := userctx.UserContext{ID: parseUID(t, ids[0]), Preset: ids[1]}
		for res := rbac.ResourceProject; res <= rbac.ResourceAudit; res++ {
			want := engine.ScopeName(m.ScopeForUser(u, res, engine.ActionView))
			if got := engine.ViewScopeCodeUser(u, res); got != want {
				t.Errorf("preset %s: view scope of %v = %q, want %q", ids[1], res, got, want)
			}
		}
	}
}

// authorizeFromMatrix mirrors the old owner-chain decision over the data
// matrix — the golden reference for the Casbin matcher. The acting user id is
// u.ID (the subject id must match the role assignment).
func authorizeFromMatrix(m engine.Matrix, u userctx.UserContext, s ownerSample) bool {
	switch m.ScopeForUser(u, s.res, s.act) {
	case engine.ScopeProjectOwner:
		return u.ID != 0 && s.own.ProjectOwner == u.ID
	case engine.ScopeProcessOwner:
		return u.ID != 0 && s.own.ProcessOwner == u.ID
	case engine.ScopeNone:
		return false
	case engine.ScopeAll:
		return true
	case engine.ScopeOwn:
		return u.ID != 0 && ownerOf(s.res, s.own) == u.ID
	case engine.ScopeParent:
		return u.ID != 0 && parentOf(s.res, s.own) == u.ID
	case engine.ScopeAncestor:
		return u.ID == s.own.Owner || u.ID == s.own.ProcessOwner || u.ID == s.own.ProjectOwner
	default:
		return false
	}
}

func ownerOf(res rbac.Resource, o rbac.Owners) int64 {
	switch res {
	case rbac.ResourceProject:
		return o.ProjectOwner
	case rbac.ResourceProcess:
		return o.ProcessOwner
	case rbac.ResourceTask, rbac.ResourceResource, rbac.ResourceWorker:
		return o.Owner
	case rbac.ResourceMilestone, rbac.ResourceAssignment, rbac.ResourceState,
		rbac.ResourceComment, rbac.ResourceUserCatalog, rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin, rbac.ResourceStateAdmin, rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return 0
	}
	return 0
}

func parentOf(res rbac.Resource, o rbac.Owners) int64 {
	switch res {
	case rbac.ResourceProcess:
		return o.ProjectOwner
	case rbac.ResourceTask, rbac.ResourceMilestone, rbac.ResourceAssignment:
		return o.ProcessOwner
	case rbac.ResourceProject, rbac.ResourceState, rbac.ResourceResource,
		rbac.ResourceWorker, rbac.ResourceComment, rbac.ResourceUserCatalog,
		rbac.ResourceRBACConfig, rbac.ResourceUserAdmin, rbac.ResourceStateAdmin,
		rbac.ResourceOrgStructure, rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return 0
	}
	return 0
}

// TestCasbinOverridePrecedence checks the ACL semantics over the matrix:
// a user-level grant wins over the preset; a user-level revoke beats both the
// grant and the preset; the admin bypass ignores deny rows; CurrentMatrix
// exposes only the preset rows.
func TestCasbinOverridePrecedence(t *testing.T) { //nolint:paralleltest // общий snapshot движка — не параллельно
	// Sequential: publishes user rows into the shared snapshot.
	publishWithRules(t,
		[]engine.RuleGrant{{Sub: "7", Key: "task/view", Scope: "all"}},
		[]engine.RuleDeny{
			{Sub: "7", Key: "task/create"},
			{Sub: "9", Key: "project/view"}, // the admin bypass must ignore it
		},
		[]engine.RoleAssign{{User: "7", Preset: userdomain.PresetWorker}},
	)

	// Grant wins over the (empty) worker preset.
	granted := userctx.UserContext{ID: 7, Preset: userdomain.PresetWorker}
	if got := engine.ScopeForUser(granted, rbac.ResourceTask, engine.ActionView); got != engine.ScopeAll {
		t.Errorf("grant override: got %v; want all", got)
	}
	// The revoke beats the worker's (absent) preset — no task.create at all.
	if engine.CanUser(granted, rbac.ResourceTask, engine.ActionCreate) {
		t.Errorf("revoke override: task.create must be denied")
	}

	// Admin bypass ignores the deny rows entirely.
	adminUser := userctx.UserContext{ID: 9, Preset: userdomain.PresetAdmin, Admin: true}
	if got := engine.ViewScopeCodeUser(adminUser, rbac.ResourceProject); got != "all" {
		t.Errorf("admin bypass vs deny row: got %q; want all", got)
	}

	// CurrentMatrix exposes only preset rows (numeric user ids filtered out).
	for _, cell := range engine.CurrentMatrix().Rules() {
		if cell.Role == "7" || cell.Role == "9" {
			t.Errorf("CurrentMatrix leaked a user-level rule %q", cell.Role)
		}
	}
}

// TestCasbinConcurrentReads runs the matcher from many goroutines against one
// published snapshot (the race detector verifies that the published enforcer
// is read-only and immutable).
func TestCasbinConcurrentReads(t *testing.T) { //nolint:paralleltest // общий snapshot движка — не параллельно
	publishWithRules(t, nil, nil, []engine.RoleAssign{{User: "5", Preset: userdomain.PresetProjectManager}})
	u := userctx.UserContext{ID: 5, Preset: userdomain.PresetProjectManager}
	var wg sync.WaitGroup
	for i := range 64 {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			ok := engine.AuthorizeUser(
				u,
				rbac.ResourceTask,
				engine.ActionView,
				rbac.Owners{ProjectOwner: 1, ProcessOwner: id},
				u.ID,
			)
			if ok {
				t.Errorf("RP cannot gain project access through process ownership")
			}
			_ = engine.ViewScopeCodeUser(u, rbac.ResourceProject)
		}(int64(1 + i%10))
	}
	wg.Wait()
}

func parseUID(t *testing.T, s string) int64 {
	t.Helper()
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("bad uid %q: %v", s, err)
	}
	return v
}
