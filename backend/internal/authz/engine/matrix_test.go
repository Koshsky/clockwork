package engine_test

import (
	"testing"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

const (
	admin  = "admin"
	dp     = "dp"
	rp     = "rp"
	vp     = "vp"
	worker = "worker"

	uAdmin = int64(1)
	uDP    = int64(2)
	uRP    = int64(3)
	uVP1   = int64(4)
	uVP2   = int64(5)
)

// Canonical owners: the project belongs to rp, the process to vp1.
//
//nolint:gochecknoglobals // rule registry
var projectOfRP = rbac.Owners{ProjectOwner: uRP}

//nolint:gochecknoglobals // rule registry
var processOfVP1 = rbac.Owners{ProjectOwner: uRP, ProcessOwner: uVP1}

func TestAuthorize_Project(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		role    string
		act     engine.Action
		owners  rbac.Owners
		userID  int64
		allowed bool
	}{
		// View
		{"admin sees any", admin, engine.ActionView, rbac.Owners{}, uAdmin, true},
		{"dp sees any", dp, engine.ActionView, rbac.Owners{}, uDP, true},
		{"rp sees own", rp, engine.ActionView, projectOfRP, uRP, true},
		{"rp does not see foreign", rp, engine.ActionView, projectOfRP, uVP1, false},
		{"vp sees none", vp, engine.ActionView, projectOfRP, uVP1, false},
		{"worker sees none", worker, engine.ActionView, projectOfRP, uAdmin, false},
		// Create
		{"admin creates", admin, engine.ActionCreate, rbac.Owners{}, uAdmin, true},
		{"rp creates own", rp, engine.ActionCreate, rbac.Owners{ProjectOwner: uRP}, uRP, true},
		{"rp cannot create for another", rp, engine.ActionCreate, rbac.Owners{ProjectOwner: uVP1}, uRP, false},
		{"dp cannot create", dp, engine.ActionCreate, rbac.Owners{}, uDP, false},
		{"vp cannot create", vp, engine.ActionCreate, rbac.Owners{}, uVP1, false},
		// Update (all fields including priority are one action)
		{"admin updates any", admin, engine.ActionUpdate, projectOfRP, uAdmin, true},
		{"dp cannot edit metadata", dp, engine.ActionUpdate, projectOfRP, uDP, false},
		{"rp updates own", rp, engine.ActionUpdate, projectOfRP, uRP, true},
		{"rp updates foreign", rp, engine.ActionUpdate, projectOfRP, uVP1, false},
		{"vp cannot update", vp, engine.ActionUpdate, projectOfRP, uVP1, false},
		// Delete
		{"admin deletes", admin, engine.ActionDelete, projectOfRP, uAdmin, true},
		{"rp deletes own", rp, engine.ActionDelete, projectOfRP, uRP, true},
		{"rp deletes foreign", rp, engine.ActionDelete, projectOfRP, uVP1, false},
		{"dp cannot delete", dp, engine.ActionDelete, projectOfRP, uDP, false},
		{"vp cannot delete", vp, engine.ActionDelete, projectOfRP, uVP1, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := engine.Authorize(
				tc.role,
				rbac.ResourceProject,
				tc.act,
				tc.owners,
				tc.userID,
			); got != tc.allowed {
				t.Errorf("engine.Authorize(%s, project, %v) = %v, want %v", tc.role, tc.act, got, tc.allowed)
			}
		})
	}
}

func TestAuthorize_Process(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		role    string
		act     engine.Action
		owners  rbac.Owners
		userID  int64
		allowed bool
	}{
		// View
		{"admin sees any", admin, engine.ActionView, processOfVP1, uAdmin, true},
		{"dp sees any", dp, engine.ActionView, processOfVP1, uDP, true},
		{"rp sees own project's process", rp, engine.ActionView, processOfVP1, uRP, true},
		{"rp does not see foreign process", rp, engine.ActionView, processOfVP1, uVP1, false},
		{"vp sees own process", vp, engine.ActionView, processOfVP1, uVP1, true},
		{"vp cannot see foreign process", vp, engine.ActionView, processOfVP1, uVP2, false},
		{"worker sees none", worker, engine.ActionView, processOfVP1, uVP1, false},
		// Create (in own project)
		{"admin creates", admin, engine.ActionCreate, processOfVP1, uAdmin, true},
		{"rp creates in own project", rp, engine.ActionCreate, processOfVP1, uRP, true},
		{"rp cannot create in foreign project", rp, engine.ActionCreate, processOfVP1, uVP1, false},
		{"vp process create scope", vp, engine.ActionCreate, processOfVP1, uVP1, true},
		{"dp cannot create", dp, engine.ActionCreate, processOfVP1, uDP, false},
		// Update/delete
		{"rp updates own project's process", rp, engine.ActionUpdate, processOfVP1, uRP, true},
		{"vp updates own process", vp, engine.ActionUpdate, processOfVP1, uVP1, true},
		{"dp cannot update process", dp, engine.ActionUpdate, processOfVP1, uDP, false},
		{"rp deletes own project's process", rp, engine.ActionDelete, processOfVP1, uRP, true},
		{"vp deletes own process", vp, engine.ActionDelete, processOfVP1, uVP1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := engine.Authorize(
				tc.role,
				rbac.ResourceProcess,
				tc.act,
				tc.owners,
				tc.userID,
			); got != tc.allowed {
				t.Errorf("engine.Authorize(%s, process, %v) = %v, want %v", tc.role, tc.act, got, tc.allowed)
			}
		})
	}
}

func TestAuthorize_TaskMilestoneAssignment(t *testing.T) {
	t.Parallel()
	resources := []struct {
		name string
		res  rbac.Resource
	}{
		{"task", rbac.ResourceTask},
		{"milestone", rbac.ResourceMilestone},
		{"assignment", rbac.ResourceAssignment},
	}
	for _, r := range resources {
		t.Run(r.name, func(t *testing.T) {
			t.Parallel()
			cases := []struct {
				name    string
				role    string
				act     engine.Action
				owners  rbac.Owners
				userID  int64
				allowed bool
			}{
				// View
				{"admin sees any", admin, engine.ActionView, processOfVP1, uAdmin, true},
				{"dp sees any", dp, engine.ActionView, processOfVP1, uDP, true},
				{"rp sees own project's", rp, engine.ActionView, processOfVP1, uRP, true},
				// ancestor = any owner up the chain: rp, matching
				// the process owner, also sees.
				{
					"rp — любой владелец по цепочке (владелец процесса)",
					rp,
					engine.ActionView,
					processOfVP1,
					uVP1,
					false,
				},
				{"rp — не совпал ни с одним владельцем", rp, engine.ActionView, processOfVP1, uVP2, false},
				// ancestor = the whole ownership chain, including the row owner (self).
				{"row ownership alone is insufficient", rp, engine.ActionView, rbac.Owners{Owner: uVP1}, uVP1, false},
				{"vp sees own process's", vp, engine.ActionView, processOfVP1, uVP1, true},
				{"vp does not see foreign process's", vp, engine.ActionView, processOfVP1, uVP2, false},
				{"worker sees none", worker, engine.ActionView, processOfVP1, uVP1, false},
				// Create
				{"admin creates", admin, engine.ActionCreate, processOfVP1, uAdmin, true},
				{"vp creates in own process", vp, engine.ActionCreate, processOfVP1, uVP1, true},
				{"vp cannot create in foreign process", vp, engine.ActionCreate, processOfVP1, uVP2, false},
				{"rp creates in own project", rp, engine.ActionCreate, processOfVP1, uRP, true},
				{"dp cannot create", dp, engine.ActionCreate, processOfVP1, uDP, false},
				// Update/delete
				{"admin updates", admin, engine.ActionUpdate, processOfVP1, uAdmin, true},
				{"vp updates own process's", vp, engine.ActionUpdate, processOfVP1, uVP1, true},
				{"rp updates own project contents", rp, engine.ActionUpdate, processOfVP1, uRP, true},
				{"dp cannot update", dp, engine.ActionUpdate, processOfVP1, uDP, false},
				{"admin deletes", admin, engine.ActionDelete, processOfVP1, uAdmin, true},
				{"vp deletes own process's", vp, engine.ActionDelete, processOfVP1, uVP1, true},
				{"rp deletes own project contents", rp, engine.ActionDelete, processOfVP1, uRP, true},
			}
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					t.Parallel()
					if got := engine.Authorize(tc.role, r.res, tc.act, tc.owners, tc.userID); got != tc.allowed {
						t.Errorf(
							"engine.Authorize(%s, %s, %v) = %v, want %v",
							tc.role,
							r.name,
							tc.act,
							got,
							tc.allowed,
						)
					}
				})
			}
		})
	}
}

func TestOwnersSharesOwner(t *testing.T) {
	t.Parallel()
	taskOfVP1 := rbac.Owners{ProjectOwner: uRP, ProcessOwner: uVP1}
	taskOfVP2 := rbac.Owners{ProjectOwner: uRP, ProcessOwner: uVP2}
	resourceOfVP1 := rbac.Owners{Owner: uVP1}
	resourceOfVP2 := rbac.Owners{Owner: uVP2}
	noOwner := rbac.Owners{}

	cases := []struct {
		name string
		a    rbac.Owners
		b    rbac.Owners
		want bool
	}{
		{"shares process owner", taskOfVP1, resourceOfVP1, true},
		{"shares process owner (vp2)", taskOfVP2, resourceOfVP2, true},
		{"different owners", taskOfVP1, resourceOfVP2, false},
		{"shares project owner", rbac.Owners{ProjectOwner: uRP}, rbac.Owners{ProjectOwner: uRP}, true},
		{"no owners", noOwner, noOwner, false},
		{"empty chain on one side", noOwner, resourceOfVP1, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := tc.a.SharesOwner(tc.b); got != tc.want {
				t.Errorf("SharesOwner(%+v, %+v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestCan(t *testing.T) {
	t.Parallel()
	cases := []struct {
		role string
		res  rbac.Resource
		act  engine.Action
		want bool
	}{
		{rp, rbac.ResourceTask, engine.ActionUpdate, true},     // RP manages project contents
		{vp, rbac.ResourceTask, engine.ActionUpdate, true},     // vp changes tasks of own processes
		{rp, rbac.ResourceProcess, engine.ActionCreate, true},  // rp creates processes
		{vp, rbac.ResourceProcess, engine.ActionCreate, true},  // VP creates own processes in visible projects
		{dp, rbac.ResourceProject, engine.ActionUpdate, false}, // DP only changes priorities
		{vp, rbac.ResourceProject, engine.ActionUpdate, false}, // vp does not edit projects
		{worker, rbac.ResourceTask, engine.ActionView, false},  // worker sees nothing
	}
	for _, tc := range cases {
		if got := engine.Can(tc.role, tc.res, tc.act); got != tc.want {
			t.Errorf("engine.Can(%s, %v, %v) = %v, want %v", tc.role, tc.res, tc.act, got, tc.want)
		}
	}
}

func TestAuthorize_Timesheet(t *testing.T) {
	t.Parallel()
	resourceOfVP := rbac.Owners{Owner: uVP1}
	workerOfVP := rbac.Owners{Owner: uVP1}

	cases := []struct {
		name    string
		res     rbac.Resource
		act     engine.Action
		role    string
		owners  rbac.Owners
		userID  int64
		allowed bool
	}{
		// === States ===
		{"admin views states", rbac.ResourceState, engine.ActionView, admin, rbac.Owners{}, uAdmin, true},
		{
			"vp views states (reference for the timesheet)",
			rbac.ResourceState,
			engine.ActionView,
			vp,
			rbac.Owners{},
			uVP1,
			true,
		},
		{"rp does not view states", rbac.ResourceState, engine.ActionView, rp, rbac.Owners{}, uRP, false},
		{"dp does not view states", rbac.ResourceState, engine.ActionView, dp, rbac.Owners{}, uDP, false},
		{"admin creates state", rbac.ResourceState, engine.ActionCreate, admin, rbac.Owners{}, uAdmin, true},
		{"vp cannot create state", rbac.ResourceState, engine.ActionCreate, vp, rbac.Owners{}, uVP1, false},
		{"vp cannot update state", rbac.ResourceState, engine.ActionUpdate, vp, rbac.Owners{}, uVP1, false},
		{"vp cannot delete state", rbac.ResourceState, engine.ActionDelete, vp, rbac.Owners{}, uVP1, false},
		// === Timesheet resources ===
		{"admin views all resources", rbac.ResourceResource, engine.ActionView, admin, rbac.Owners{}, uAdmin, true},
		{"vp views own resource", rbac.ResourceResource, engine.ActionView, vp, resourceOfVP, uVP1, true},
		{
			"vp does not view foreign resource",
			rbac.ResourceResource,
			engine.ActionView,
			vp,
			resourceOfVP,
			uVP2,
			false,
		},
		{"rp does not view resources", rbac.ResourceResource, engine.ActionView, rp, resourceOfVP, uRP, false},
		{"dp views resources", rbac.ResourceResource, engine.ActionView, dp, resourceOfVP, uDP, true},
		{"vp creates own resource", rbac.ResourceResource, engine.ActionCreate, vp, resourceOfVP, uVP1, true},
		{
			"vp cannot create resource for another",
			rbac.ResourceResource,
			engine.ActionCreate,
			vp,
			rbac.Owners{Owner: uVP2},
			uVP1,
			false,
		},
		{
			"rp cannot create resource",
			rbac.ResourceResource,
			engine.ActionCreate,
			rp,
			rbac.Owners{Owner: uRP},
			uRP,
			false,
		},
		{"vp updates own resource", rbac.ResourceResource, engine.ActionUpdate, vp, resourceOfVP, uVP1, true},
		{
			"vp does not update foreign resource",
			rbac.ResourceResource,
			engine.ActionUpdate,
			vp,
			resourceOfVP,
			uVP2,
			false,
		},
		{"vp deletes own resource", rbac.ResourceResource, engine.ActionDelete, vp, resourceOfVP, uVP1, true},
		// === Employees ===
		{"admin views all employees", rbac.ResourceWorker, engine.ActionView, admin, rbac.Owners{}, uAdmin, true},
		{"vp views own employee", rbac.ResourceWorker, engine.ActionView, vp, workerOfVP, uVP1, true},
		{"vp does not view foreign employee", rbac.ResourceWorker, engine.ActionView, vp, workerOfVP, uVP2, false},
		{"rp does not view employees", rbac.ResourceWorker, engine.ActionView, rp, workerOfVP, uRP, false},
		{"admin creates employee", rbac.ResourceWorker, engine.ActionCreate, admin, rbac.Owners{}, uAdmin, true},
		{"vp cannot create employee", rbac.ResourceWorker, engine.ActionCreate, vp, workerOfVP, uVP1, false},
		{
			"vp cannot create employee for another",
			rbac.ResourceWorker,
			engine.ActionCreate,
			vp,
			rbac.Owners{Owner: uVP2},
			uVP1,
			false,
		},
		{
			"rp cannot create employee",
			rbac.ResourceWorker,
			engine.ActionCreate,
			rp,
			rbac.Owners{Owner: uRP},
			uRP,
			false,
		},
		{"vp updates own employee", rbac.ResourceWorker, engine.ActionUpdate, vp, workerOfVP, uVP1, true},
		{
			"vp does not update foreign employee",
			rbac.ResourceWorker,
			engine.ActionUpdate,
			vp,
			workerOfVP,
			uVP2,
			false,
		},
		{"vp deletes own employee", rbac.ResourceWorker, engine.ActionDelete, vp, workerOfVP, uVP1, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := engine.Authorize(tc.role, tc.res, tc.act, tc.owners, tc.userID); got != tc.allowed {
				t.Errorf("engine.Authorize(%s, %v, %v) = %v, want %v", tc.role, tc.res, tc.act, got, tc.allowed)
			}
		})
	}
}

func TestViewScopeCode(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		role string
		res  rbac.Resource
		want string
	}{
		{"rp project view = own (self)", rp, rbac.ResourceProject, "self"},
		{"dp project view = all", dp, rbac.ResourceProject, "all"},
		{"rp process view = parent (up1)", rp, rbac.ResourceProcess, "project_owner"},
		{"vp process view = all", vp, rbac.ResourceProcess, "process_owner"},
		{"vp task view = parent (up1)", vp, rbac.ResourceTask, "process_owner"},
		{"rp task view = ancestor (up)", rp, rbac.ResourceTask, "project_owner"},
		{"dp task view = all", dp, rbac.ResourceTask, "all"},
		{"vp resource view = own (self)", vp, rbac.ResourceResource, "self"},
		{"worker task view = none", worker, rbac.ResourceTask, ""},
		{"admin anything = all", admin, rbac.ResourceTask, "all"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := engine.ViewScopeCode(tc.role, tc.res); got != tc.want {
				t.Errorf("ViewScopeCode(%s, %v) = %q, want %q", tc.role, tc.res, got, tc.want)
			}
		})
	}
}
