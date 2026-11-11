package engine_test

import (
	"context"
	"errors"
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

//nolint:paralleltest // Publishes grants and ancestor probes in the shared snapshot.
func TestParentViewWinsOverChildDenials(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{
		{Sub: "7", Key: "project/view", Scope: "self"},
	}, []engine.RuleDeny{
		{Sub: "7", Key: "process/view"}, {Sub: "7", Key: "task/view"},
		{Sub: "7", Key: "milestone/view"}, {Sub: "7", Key: "assignment/view"},
	}, nil)
	engine.SetOwnerProbe(&engine.OwnerProbe{
		Parents: func(_ context.Context, _ rbac.Resource, id int64) ([]engine.Target, error) {
			return []engine.Target{{Res: rbac.ResourceProject, ID: 1, Owners: rbac.Owners{ProjectOwner: id}}}, nil
		},
	})
	t.Cleanup(func() { engine.SetOwnerProbe(nil) })
	user := userctx.UserContext{ID: 7, Preset: "worker"}
	for _, res := range []rbac.Resource{
		rbac.ResourceProcess, rbac.ResourceTask, rbac.ResourceMilestone, rbac.ResourceAssignment,
	} {
		t.Run(engine.ResourceName(res), func(t *testing.T) {
			if !engine.CanUser(user, res, engine.ActionView) {
				t.Fatal("missing inherited view capability")
			}
			for _, id := range []int64{7, 8} {
				assertInheritedTarget(t, user, res, id)
			}
			scope := engine.CompileViewScopeUser(user, res)
			if scope.None || scope.All || len(scope.ProjectView) != 1 || scope.ProjectView[0] != "self" {
				t.Fatalf("inherited-only SQL scope must not use include-all fallback: %+v", scope)
			}
		})
	}
	if engine.CanUser(user, rbac.ResourceResource, engine.ActionView) {
		t.Fatal("planning view inherited into resource management")
	}
}

//nolint:paralleltest // Installs a failing shared ancestor probe.
func TestViewInheritanceProbeFailsClosed(t *testing.T) {
	publishWithRules(t, []engine.RuleGrant{{Sub: "7", Key: "project/view", Scope: "all"}}, nil, nil)
	engine.SetOwnerProbe(&engine.OwnerProbe{
		Parents: func(context.Context, rbac.Resource, int64) ([]engine.Target, error) {
			return nil, errors.New("database unavailable")
		},
	})
	t.Cleanup(func() { engine.SetOwnerProbe(nil) })
	if engine.EnforceTarget(userctx.UserContext{ID: 7, Preset: "worker"}, engine.Target{
		Res: rbac.ResourceTask, Act: engine.ActionView, ID: 1, Ctx: t.Context(),
	}) {
		t.Fatal("failed ancestry lookup granted access")
	}
}

func assertInheritedTarget(t *testing.T, user userctx.UserContext, res rbac.Resource, id int64) {
	t.Helper()
	target := engine.Target{Res: res, Act: engine.ActionView, ID: id, Ctx: t.Context()}
	if got := engine.EnforceTarget(user, target); got != (id == 7) {
		t.Fatalf("view ID %d=%v", id, got)
	}
	for _, act := range []engine.Action{engine.ActionCreate, engine.ActionUpdate, engine.ActionDelete} {
		target.Act = act
		if engine.EnforceTarget(user, target) {
			t.Fatalf("view granted %s", engine.ActionName(act))
		}
	}
}
