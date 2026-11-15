package engine_test

import (
	"context"
	"reflect"
	"strings"
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	engine "github.com/Koshsky/erp-backend/internal/authz/engine"
)

// TestScopeParseCanonical pins parsing + legacy canonicalization.
func TestScopeParseCanonical(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"", "", true},
		{"all", "all", true},
		{"none", "none", true},
		{"own", "self", true},
		{"parent", "up1", true},
		{"ancestor", "up", true},
		{"self", "self", true},
		{"up1", "up1", true},
		{"up", "up", true},
		{"up2", "up2", true},
		{"down", "down", true},
		{"down3", "down3", true},
		{"sib", "sib", true},
		{"self sib", "self sib", true},
		{"self up1 down", "self up1 down", true},
		{"bogus", "", false},
		{"up0", "", false},
		{"downx", "", false},
		{"sib1", "", false},
		{"self  sib", "self sib", true}, // whitespace normalized
		{"", "", true},
	}
	for _, tc := range cases {
		got, ok := engine.ParseScope(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("engine.ParseScope(%q) = %q, %v; want %q, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

// TestScopeApplicability pins the tree-move applicability per resource.
func TestScopeApplicability(t *testing.T) {
	t.Parallel()
	cases := []struct {
		res  access.Resource
		expr string
		want bool
	}{
		{access.ResourceProject, "all", true},
		{access.ResourceProject, "self", true},
		{access.ResourceProject, "up1", false}, // no parent
		{access.ResourceProject, "up", false},  // no parent
		{access.ResourceProject, "sib", false}, // no parent
		{access.ResourceProject, "down", true}, // owner-bearing descendants
		{access.ResourceProcess, "self", false},
		{access.ResourceProcess, "up1", true},
		{access.ResourceProcess, "sib", true},
		{access.ResourceProcess, "down", true},
		{access.ResourceTask, "self", false},
		{access.ResourceTask, "up1", true},
		{access.ResourceTask, "sib", true},
		{access.ResourceTask, "down", true},
		{access.ResourceMilestone, "self", false}, // no own owner
		{access.ResourceMilestone, "up1", true},
		{access.ResourceMilestone, "sib", false}, // ownerless siblings
		{access.ResourceMilestone, "down", false},
		{access.ResourceAssignment, "up1", true},
		{access.ResourceAssignment, "self", false},
		{access.ResourceResource, "self", true},
		{access.ResourceResource, "down", false},
		{access.ResourceWorker, "self", true},
		{access.ResourceState, "self", false},
		{access.ResourceState, "all", true},
	}
	for _, tc := range cases {
		if got := engine.ScopeApplicable(tc.res, tc.expr); got != tc.want {
			t.Errorf("engine.ScopeApplicable(%v, %q) = %v; want %v", tc.res, tc.expr, got, tc.want)
		}
	}
}

// TestEvalScopeChain pins the chain-based moves (self/up1/up) and the
// all/none shortcuts.
func TestEvalScopeChain(t *testing.T) {
	t.Parallel()
	task := access.Owners{Owner: 5, ProcessOwner: 3, ProjectOwner: 1}
	process := access.Owners{ProcessOwner: 3, ProjectOwner: 1}
	cases := []struct {
		name string
		expr string
		res  access.Resource
		own  access.Owners
		uid  int64
		want bool
	}{
		{"all grants", "all", access.ResourceTask, task, 99, true},
		{"none denies", "none", access.ResourceTask, task, 5, false},
		{"self owner ok", "self", access.ResourceTask, task, 5, true},
		{"self foreign denied", "self", access.ResourceTask, task, 6, false},
		{"up1 process owner ok", "up1", access.ResourceTask, task, 3, true},
		{"up1 project owner denied (immediate parent only)", "up1", access.ResourceTask, task, 1, false},
		{"up project owner ok", "up", access.ResourceTask, task, 1, true},
		{"up process owner ok", "up", access.ResourceProcess, process, 3, true},
		{"up1 on process = project owner", "up1", access.ResourceProcess, process, 1, true},
		{"self on milestone never", "self", access.ResourceMilestone, process, 3, false},
		{"disjunction self or up1", "self up1", access.ResourceTask, task, 3, true},
	}
	for _, tc := range cases {
		if got := engine.EvalScope(context.TODO(), tc.expr, tc.res, tc.own, tc.uid, 0, nil); got != tc.want {
			t.Errorf("%s: engine.EvalScope(%q) = %v; want %v", tc.name, tc.expr, got, tc.want)
		}
	}
}

// TestEvalScopeProbes pins the data-dependent moves (sib/down) with a stub
// probe and the nil-probe fallback (grant nothing).
func TestEvalScopeProbes(t *testing.T) {
	t.Parallel()
	probe := &engine.OwnerProbe{
		Descendant: func(_ context.Context, res access.Resource, id, userID int64) (bool, error) {
			return res == access.ResourceProject && id == 1 && userID == 5, nil
		},
		Peer: func(_ context.Context, target engine.Target, userID int64, _ bool) (bool, error) {
			return target.Res == access.ResourceProcess && target.ID == 7 && userID == 3, nil
		},
	}
	owners := access.Owners{}
	if !engine.EvalScope(context.Background(), "down", access.ResourceProject, owners, 5, 1, probe) {
		t.Error("down: owned descendant project 1 → want granted")
	}
	if engine.EvalScope(context.Background(), "down", access.ResourceProject, owners, 6, 1, probe) {
		t.Error("down: foreign user → want denied")
	}
	if !engine.EvalScope(context.Background(), "sib", access.ResourceProcess, owners, 3, 7, probe) {
		t.Error("sib: owned sibling process 7 → want granted")
	}
	if engine.EvalScope(context.Background(), "sib down", access.ResourceProcess, owners, 5, 7, probe) {
		t.Error("sib+down: no probe hit → want denied")
	}
	// Nil probe: down/sib grant nothing.
	if engine.EvalScope(context.Background(), "down", access.ResourceProject, owners, 5, 1, nil) {
		t.Error("down with nil probe → want denied")
	}
}

// TestCompileListScope pins the expression → flag-bundle compilation.
func TestCompileListScope(t *testing.T) {
	t.Parallel()
	cases := []struct {
		expr string
		want access.ListScope
	}{
		{"all", access.ListScope{All: true}},
		{"none", access.ListScope{None: true}},
		{"", access.ListScope{None: true}},
		{"self", access.ListScope{Self: true}},
		{"up1", access.ListScope{Parent: true}},
		{"up", access.ListScope{Ancestor: true}},
		{"up3", access.ListScope{Ancestor: true}},
		{"sib", access.ListScope{Sib: true}},
		{"down", access.ListScope{Down: true}},
		{"self sib", access.ListScope{Self: true, Sib: true}},
		{"self up1 sib down", access.ListScope{Self: true, Parent: true, Sib: true, Down: true}},
		{"sib_project", access.ListScope{ProjectSib: true}},
		{"project_owner", access.ListScope{ProjectOwner: true}},
		{"process_owner", access.ListScope{ProcessOwner: true}},
		{"process_projects", access.ListScope{ProcessProjects: true}},
		{"project_resources", access.ListScope{ProjectResources: true}},
		{"invalid_scope", access.ListScope{None: true}},
	}
	for _, tc := range cases {
		if got := engine.CompileListScope(tc.expr, access.ResourceTask); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("engine.CompileListScope(%q) = %+v; want %+v", tc.expr, got, tc.want)
		}
	}
}

// TestSQLSkeletonCompleteness — the per-resource SQL skeletons carry all the
// applicable flags (the queries consume them as bind parameters).
func TestSQLSkeletonCompleteness(t *testing.T) {
	t.Parallel()
	fragments := []struct {
		res      access.Resource
		skeleton string
		tokens   []string
	}{
		{access.ResourceProject, engine.ScopeProject, []string{"sc_self", "sc_down", "sc_none", "sc_all"}},
		{access.ResourceProcess, engine.ScopeProcess, []string{"sc_sib", "sc_down", "sc_parent", "sc_ancestor"}},
		{access.ResourceTask, engine.ScopeTask, []string{"sc_sib", "sc_down", "sc_self", "sc_parent"}},
		{access.ResourceMilestone, engine.ScopeMilestone, []string{"sc_parent", "sc_ancestor"}},
		{access.ResourceAssignment, engine.ScopeAssignment, []string{"sc_parent", "sc_ancestor"}},
		{access.ResourceResource, engine.ScopeResource, []string{"sc_self", "sc_none"}},
		{access.ResourceWorker, engine.ScopeUser, []string{"sc_self", "sc_none"}},
	}
	for _, frags := range fragments {
		for _, token := range frags.tokens {
			if !strings.Contains(frags.skeleton, token) {
				t.Errorf("skeleton of %v missing %q", frags.res, token)
			}
		}
	}
}
