package engine_test

import (
	"fmt"
	"testing"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
)

func TestBuiltInRoleMatrix(t *testing.T) {
	t.Parallel()
	for _, role := range []string{"admin", "dp", "rp", "vp", "worker"} {
		for res := access.ResourceProject; res <= access.ResourceAudit; res++ {
			for act := engine.ActionView; act <= engine.ActionDelete; act++ {
				for _, owners := range []access.Owners{
					{ProjectOwner: 7, ProcessOwner: 8, Owner: 9},
					{ProjectOwner: 8, ProcessOwner: 7, Owner: 9},
					{ProjectOwner: 8, ProcessOwner: 9, Owner: 7},
					{},
				} {
					name := fmt.Sprintf("%s/%s/%s/%v", role, engine.ResourceName(res), engine.ActionName(act), owners)
					t.Run(name, func(t *testing.T) {
						t.Parallel()
						want := factoryAllowed(role, res, act, owners)
						if got := engine.Authorize(role, res, act, owners, 7); got != want {
							t.Fatalf("allowed=%v, want %v", got, want)
						}
					})
				}
			}
		}
	}
}

func factoryAllowed(role string, res access.Resource, act engine.Action, o access.Owners) bool {
	if role == "admin" {
		return true
	}
	planning := res >= access.ResourceProject && res <= access.ResourceAssignment
	if role == "dp" {
		return act == engine.ActionView &&
			(planning || res == access.ResourceResource || res == access.ResourceUserCatalog)
	}
	if role == "rp" {
		return (planning && o.ProjectOwner == 7) ||
			(act == engine.ActionView && (res == access.ResourceUserCatalog || (res == access.ResourceResource && o.Owner == 7)))
	}
	if role == "vp" {
		return (planning && res != access.ResourceProject && o.ProcessOwner == 7) ||
			(res == access.ResourceResource && o.Owner == 7) ||
			(res == access.ResourceWorker && act != engine.ActionCreate && o.Owner == 7) ||
			(act == engine.ActionView && (res == access.ResourceState || res == access.ResourceUserCatalog))
	}
	return false
}

func TestProjectPriorityCapability(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		role  string
		owner int64
		want  bool
	}{
		{"admin", 9, true}, {"dp", 9, true}, {"rp", 7, true},
		{"rp", 9, false}, {"vp", 7, false}, {"worker", 7, false},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.role, tc.owner), func(t *testing.T) {
			t.Parallel()
			if got := engine.Authorize(tc.role, access.ResourceProject, engine.ActionPrioritize,
				access.Owners{ProjectOwner: tc.owner}, 7); got != tc.want {
				t.Fatalf("priority=%v, want %v", got, tc.want)
			}
		})
	}
	for res := access.ResourceProject; res <= access.ResourceAudit; res++ {
		if got := engine.ActionApplicable(res, engine.ActionPrioritize); got != (res == access.ResourceProject) {
			t.Errorf("priority applicability for %s", engine.ResourceName(res))
		}
	}
}
