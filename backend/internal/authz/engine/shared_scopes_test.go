package engine_test

import (
	"context"
	"errors"
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

func TestProjectPeerScope(t *testing.T) {
	t.Parallel()
	for _, expr := range []string{"sib_project", "sib sib_project", "up1 sib_project down"} {
		t.Run(expr, func(t *testing.T) {
			t.Parallel()
			canon, ok := engine.ParseScope(expr)
			if !ok || canon != expr {
				t.Fatalf("parse %q = %q, %v", expr, canon, ok)
			}
			if !engine.ScopeApplicable(access.ResourceTask, expr) {
				t.Fatal("task project peers must be applicable")
			}
		})
	}
	for _, expr := range []string{"sib_project1", "sib_project0", "sib_projectx"} {
		if _, ok := engine.ParseScope(expr); ok {
			t.Errorf("accepted invalid expression %q", expr)
		}
	}
	for _, res := range []access.Resource{
		access.ResourceProject, access.ResourceProcess, access.ResourceMilestone,
		access.ResourceAssignment, access.ResourceResource,
	} {
		if engine.ScopeApplicable(res, "sib_project") {
			t.Errorf("project peers must be task-only: %v", res)
		}
	}
	got := engine.CompileListScope("sib sib_project", access.ResourceTask)
	if !got.Sib || !got.ProjectSib || got.All || got.Ancestor || got.Parent {
		t.Fatalf("independent peer flags: %+v", got)
	}
}

func TestIndependentPeerProbes(t *testing.T) {
	t.Parallel()
	const userID, taskID = int64(7), int64(12)
	ctx := context.Background()
	for _, project := range []bool{false, true} {
		expr := "sib"
		if project {
			expr = "sib_project"
		}
		probe := &engine.OwnerProbe{
			Peer: func(_ context.Context, target engine.Target, uid int64, byProject bool) (bool, error) {
				sameTarget := target.Res == access.ResourceTask && target.ID == taskID
				return sameTarget && uid == userID && byProject == project, nil
			},
		}
		if !engine.EvalScope(ctx, expr, access.ResourceTask, access.Owners{}, userID, taskID, probe) {
			t.Errorf("%s did not select its peer probe", expr)
		}
		owners := access.Owners{ProjectOwner: userID, ProcessOwner: userID}
		if engine.EvalScope(ctx, expr, access.ResourceTask, owners, userID, taskID, nil) {
			t.Errorf("%s inferred task peer access from ancestor ownership", expr)
		}
	}
	probe := &engine.OwnerProbe{Peer: func(context.Context, engine.Target, int64, bool) (bool, error) {
		return true, errors.New("probe unavailable")
	}}
	if engine.EvalScope(ctx, "sib sib_project", access.ResourceTask, access.Owners{}, userID, taskID, probe) {
		t.Fatal("probe failures must deny access")
	}
}
