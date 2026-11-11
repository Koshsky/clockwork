package engine_test

import (
	"context"
	"reflect"
	"strings"
	"testing"

	engine "github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
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
		res  rbac.Resource
		expr string
		want bool
	}{
		{rbac.ResourceProject, "all", true},
		{rbac.ResourceProject, "self", true},
		{rbac.ResourceProject, "up1", false}, // no parent
		{rbac.ResourceProject, "up", false},  // no parent
		{rbac.ResourceProject, "sib", false}, // no parent
		{rbac.ResourceProject, "down", true}, // owner-bearing descendants
		{rbac.ResourceProcess, "self", false},
		{rbac.ResourceProcess, "up1", true},
		{rbac.ResourceProcess, "sib", true},
		{rbac.ResourceProcess, "down", true},
		{rbac.ResourceTask, "self", false},
		{rbac.ResourceTask, "up1", true},
		{rbac.ResourceTask, "sib", true},
		{rbac.ResourceTask, "down", true},
		{rbac.ResourceMilestone, "self", false}, // no own owner
		{rbac.ResourceMilestone, "up1", true},
		{rbac.ResourceMilestone, "sib", false}, // ownerless siblings
		{rbac.ResourceMilestone, "down", false},
		{rbac.ResourceAssignment, "up1", true},
		{rbac.ResourceAssignment, "self", false},
		{rbac.ResourceResource, "self", true},
		{rbac.ResourceResource, "down", false},
		{rbac.ResourceWorker, "self", true},
		{rbac.ResourceState, "self", false},
		{rbac.ResourceState, "all", true},
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
	task := rbac.Owners{Owner: 5, ProcessOwner: 3, ProjectOwner: 1}
	process := rbac.Owners{ProcessOwner: 3, ProjectOwner: 1}
	cases := []struct {
		name string
		expr string
		res  rbac.Resource
		own  rbac.Owners
		uid  int64
		want bool
	}{
		{"all grants", "all", rbac.ResourceTask, task, 99, true},
		{"none denies", "none", rbac.ResourceTask, task, 5, false},
		{"self owner ok", "self", rbac.ResourceTask, task, 5, true},
		{"self foreign denied", "self", rbac.ResourceTask, task, 6, false},
		{"up1 process owner ok", "up1", rbac.ResourceTask, task, 3, true},
		{"up1 project owner denied (immediate parent only)", "up1", rbac.ResourceTask, task, 1, false},
		{"up project owner ok", "up", rbac.ResourceTask, task, 1, true},
		{"up process owner ok", "up", rbac.ResourceProcess, process, 3, true},
		{"up1 on process = project owner", "up1", rbac.ResourceProcess, process, 1, true},
		{"self on milestone never", "self", rbac.ResourceMilestone, process, 3, false},
		{"disjunction self or up1", "self up1", rbac.ResourceTask, task, 3, true},
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
		Descendant: func(_ context.Context, res rbac.Resource, id, userID int64) (bool, error) {
			return res == rbac.ResourceProject && id == 1 && userID == 5, nil
		},
		Peer: func(_ context.Context, target engine.Target, userID int64, _ bool) (bool, error) {
			return target.Res == rbac.ResourceProcess && target.ID == 7 && userID == 3, nil
		},
	}
	owners := rbac.Owners{}
	if !engine.EvalScope(context.Background(), "down", rbac.ResourceProject, owners, 5, 1, probe) {
		t.Error("down: owned descendant project 1 → want granted")
	}
	if engine.EvalScope(context.Background(), "down", rbac.ResourceProject, owners, 6, 1, probe) {
		t.Error("down: foreign user → want denied")
	}
	if !engine.EvalScope(context.Background(), "sib", rbac.ResourceProcess, owners, 3, 7, probe) {
		t.Error("sib: owned sibling process 7 → want granted")
	}
	if engine.EvalScope(context.Background(), "sib down", rbac.ResourceProcess, owners, 5, 7, probe) {
		t.Error("sib+down: no probe hit → want denied")
	}
	// Nil probe: down/sib grant nothing.
	if engine.EvalScope(context.Background(), "down", rbac.ResourceProject, owners, 5, 1, nil) {
		t.Error("down with nil probe → want denied")
	}
}

// TestCompileListScope pins the expression → flag-bundle compilation.
func TestCompileListScope(t *testing.T) {
	t.Parallel()
	cases := []struct {
		expr string
		want rbac.ListScope
	}{
		{"all", rbac.ListScope{All: true}},
		{"none", rbac.ListScope{None: true}},
		{"", rbac.ListScope{None: true}},
		{"self", rbac.ListScope{Self: true}},
		{"up1", rbac.ListScope{Parent: true}},
		{"up", rbac.ListScope{Ancestor: true}},
		{"up3", rbac.ListScope{Ancestor: true}},
		{"sib", rbac.ListScope{Sib: true}},
		{"down", rbac.ListScope{Down: true}},
		{"self sib", rbac.ListScope{Self: true, Sib: true}},
		{"self up1 sib down", rbac.ListScope{Self: true, Parent: true, Sib: true, Down: true}},
	}
	for _, tc := range cases {
		if got := engine.CompileListScope(tc.expr, rbac.ResourceTask); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("engine.CompileListScope(%q) = %+v; want %+v", tc.expr, got, tc.want)
		}
	}
}

// TestSQLSkeletonCompleteness — the per-resource SQL skeletons carry all the
// applicable flags (the queries consume them as bind parameters).
func TestSQLSkeletonCompleteness(t *testing.T) {
	t.Parallel()
	fragments := []struct {
		res      rbac.Resource
		skeleton string
		tokens   []string
	}{
		{rbac.ResourceProject, engine.ScopeProject, []string{"sc_self", "sc_down", "sc_none", "sc_all"}},
		{rbac.ResourceProcess, engine.ScopeProcess, []string{"sc_sib", "sc_down", "sc_parent", "sc_ancestor"}},
		{rbac.ResourceTask, engine.ScopeTask, []string{"sc_sib", "sc_down", "sc_self", "sc_parent"}},
		{rbac.ResourceMilestone, engine.ScopeMilestone, []string{"sc_parent", "sc_ancestor"}},
		{rbac.ResourceAssignment, engine.ScopeAssignment, []string{"sc_parent", "sc_ancestor"}},
		{rbac.ResourceResource, engine.ScopeResource, []string{"sc_self", "sc_none"}},
		{rbac.ResourceWorker, engine.ScopeUser, []string{"sc_self", "sc_none"}},
	}
	for _, frags := range fragments {
		for _, token := range frags.tokens {
			if !strings.Contains(frags.skeleton, token) {
				t.Errorf("skeleton of %v missing %q", frags.res, token)
			}
		}
	}
}
