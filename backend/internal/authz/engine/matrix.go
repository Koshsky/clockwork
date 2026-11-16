package engine

// Access rules data: the permission matrix (preset × resource × action →
// ownership scope) as plain data, its codecs (resources/actions/scopes) and
// the tree-zone applicability. Scopes are now EXPRESSIONS over the ownership
// tree (see scopeexpr.go): legacy zones ({own, parent, ancestor}) map 1:1 to
// expressions ({self, up1, up}); the matrix remains the reset source and the
// compiled view of the Casbin allow policies.

import (
	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
)

// Action — an operation on an entity.
type Action int

const (
	ActionView Action = iota
	ActionCreate
	ActionUpdate
	ActionDelete
	ActionPrioritize
)

// Scope — the ownership-scope expression required for an action. Legacy zone
// codes map to expressions: own→"self", parent→"up1", ancestor→"up". Absence
// of a rule = ScopeNone (no access).
const (
	ScopeNone             = ""    // no rule / explicit deny
	ScopeAll              = "all" // unconditional access
	ScopeOwn              = "self"
	ScopeParent           = "up1"
	ScopeAncestor         = "up"
	ScopeProjectOwner     = "project_owner"
	ScopeProcessOwner     = "process_owner"
	ScopeProcessProjects  = "process_projects"
	ScopeProjectResources = "project_resources"

	// ScopeNoneCode is the wire code of "no right" in the API matrix payload.
	// ScopeNone itself is the empty string, which the UI cannot distinguish
	// from a granted cell — the served payload spells the denial out.
	ScopeNoneCode = "none"
)

// String resource codes (the same codes the RBAC catalog in V9 stores).
const (
	resProject      = "project"
	resProcess      = "process"
	resTask         = "task"
	resMilestone    = "milestone"
	resAssignment   = "assignment"
	resState        = "state"
	resResource     = "resource"
	resWorker       = "worker"
	resComment      = "comment"
	resUserCatalog  = "user_catalog"
	resRBACConfig   = "rbac_config"
	resUserAdmin    = "user_admin"
	resStateAdmin   = "state_admin"
	resOrgStructure = "org_structure"
	resAudit        = "audit"
	resAutoCreate   = "auto_create"
)

// String action codes.
const (
	actView       = "view"
	actCreate     = "create"
	actUpdate     = "update"
	actDelete     = "delete"
	actPrioritize = "prioritize"
)

// Rule binds a preset and the required access scope expression.
type Rule struct {
	Role  string
	Scope string
}

// MatrixRule — a matrix row (for building from the DB and defaults).
type MatrixRule struct {
	Res   access.Resource
	Act   Action
	Role  string
	Scope string
}

// DefaultMatrixRules returns the built-in matrix rules (for reset).
func DefaultMatrixRules() []MatrixRule {
	var out []MatrixRule
	for res, byAction := range defaultMatrix.rules {
		for act, rules := range byAction {
			for _, r := range rules {
				out = append(out, MatrixRule{Res: res, Act: act, Role: r.Role, Scope: r.Scope})
			}
		}
	}
	return out
}

// Matrix — a snapshot of the permission matrix (preset × resource × action → rules).
type Matrix struct {
	rules map[access.Resource]map[Action][]Rule
}

// NewMatrix assembles a matrix from rules. (role, resource, action) pairs
// are unique: the last rule wins.
func NewMatrix(rules []MatrixRule) Matrix {
	m := Matrix{rules: make(map[access.Resource]map[Action][]Rule)}
	for _, r := range rules {
		byAction, ok := m.rules[r.Res]
		if !ok {
			byAction = make(map[Action][]Rule)
			m.rules[r.Res] = byAction
		}
		replaced := false
		for i, existing := range byAction[r.Act] {
			if existing.Role == r.Role {
				byAction[r.Act][i] = Rule{Role: r.Role, Scope: r.Scope}
				replaced = true
				break
			}
		}
		if !replaced {
			byAction[r.Act] = append(byAction[r.Act], Rule{Role: r.Role, Scope: r.Scope})
		}
	}
	return m
}

// Rules returns the matrix rows (the inverse of NewMatrix).
func (m Matrix) Rules() []MatrixRule {
	var out []MatrixRule
	for res, byAction := range m.rules {
		for act, rules := range byAction {
			for _, r := range rules {
				out = append(out, MatrixRule{Res: res, Act: act, Role: r.Role, Scope: r.Scope})
			}
		}
	}
	return out
}

//nolint:gochecknoglobals // factory policies are the versioned reset source
var defaultMatrix = newDefaultMatrix()

func newDefaultMatrix() Matrix {
	var rules []MatrixRule
	grant := func(role string, res access.Resource, scope string, actions ...Action) {
		for _, action := range actions {
			rules = append(rules, MatrixRule{Role: role, Res: res, Act: action, Scope: scope})
		}
	}
	for _, res := range []access.Resource{
		access.ResourceProject, access.ResourceProcess, access.ResourceTask,
		access.ResourceMilestone, access.ResourceAssignment,
	} {
		grant(userdomain.PresetProjectDirector, res, ScopeAll, ActionView)
		scope := ScopeProjectOwner
		if res == access.ResourceProject {
			scope = ScopeOwn
		}
		grant(userdomain.PresetProjectManager, res, scope, ActionView, ActionCreate, ActionUpdate, ActionDelete)
		if res != access.ResourceProject {
			grant(userdomain.PresetProcessOwner, res, ScopeProcessOwner,
				ActionView, ActionCreate, ActionUpdate, ActionDelete)
		}
	}
	grant(userdomain.PresetProjectDirector, access.ResourceProject, ScopeAll, ActionPrioritize)
	grant(userdomain.PresetProjectManager, access.ResourceProject, ScopeOwn, ActionPrioritize)
	grant(userdomain.PresetProcessOwner, access.ResourceProject, ScopeProcessProjects, ActionView)
	grant(userdomain.PresetProjectDirector, access.ResourceResource, ScopeAll, ActionView)
	grant(userdomain.PresetProjectManager, access.ResourceResource, "self project_resources", ActionView)
	grant(userdomain.PresetProcessOwner, access.ResourceResource, ScopeOwn,
		ActionView, ActionCreate, ActionUpdate, ActionDelete)
	grant(userdomain.PresetProcessOwner, access.ResourceState, ScopeAll, ActionView)
	grant(userdomain.PresetProcessOwner, access.ResourceWorker, ScopeOwn, ActionView, ActionUpdate, ActionDelete)
	for _, role := range []string{
		userdomain.PresetProjectDirector, userdomain.PresetProjectManager, userdomain.PresetProcessOwner,
	} {
		grant(role, access.ResourceUserCatalog, ScopeAll, ActionView)
	}
	return NewMatrix(rules)
}

// ActionApplicable keeps the priority-only capability on projects.
func ActionApplicable(res access.Resource, action Action) bool {
	if action == ActionPrioritize {
		return res == access.ResourceProject
	}
	switch res {
	case access.ResourceStateAdmin:
		return false
	case access.ResourceRBACConfig:
		return action == ActionUpdate
	case access.ResourceAutoCreate:
		return action == ActionView || action == ActionUpdate
	case access.ResourceUserCatalog, access.ResourceOrgStructure, access.ResourceAudit:
		return action == ActionView
	case access.ResourceProject, access.ResourceProcess, access.ResourceTask, access.ResourceMilestone,
		access.ResourceAssignment, access.ResourceState, access.ResourceResource, access.ResourceWorker,
		access.ResourceComment, access.ResourceUserAdmin:
		return true
	default:
		return false
	}
}

// DefaultMatrix returns the built-in default matrix (a copy).
func DefaultMatrix() Matrix {
	return defaultMatrix
}

// ScopeFor returns the required access scope expression for (preset, resource, action).
// admin gets ScopeAll (a protective invariant, not stored in the DB).
func (m Matrix) ScopeFor(role string, res access.Resource, act Action) string {
	if role == userdomain.PresetAdmin {
		return ScopeAll
	}
	rules, ok := m.rules[res][act]
	if !ok {
		return ScopeNone
	}
	for _, r := range rules {
		if r.Role == role {
			return r.Scope
		}
	}
	return ScopeNone
}

// overrideScope returns the caller's individual override for (resource, action):
// (scope, true) — an explicit grant/revoke rule matched; (ScopeNone, false) —
// no override (fall back to the preset).
func overrideScope(u access.UserContext, res access.Resource, act Action) (string, bool) {
	for _, r := range u.Rules {
		if r.Resource != ResourceName(res) || r.Action != ActionName(act) {
			continue
		}
		if !r.Granted {
			return ScopeNone, true
		}
		scope, ok := ParseScope(r.Scope)
		if !ok {
			return ScopeNone, true
		}
		return scope, true
	}
	return ScopeNone, false
}

// ScopeForUser returns the caller's effective scope expression for (resource, action):
// admin — ScopeAll (a bypass; overrides do not apply); a per-user override —
// its expression (a revoked rule — ScopeNone); otherwise the preset matrix rule.
// This is the data-level view (used by the admin editor views); the runtime
// decisions go through the Casbin snapshot (ScopeForUser in decision.go).
func (m Matrix) ScopeForUser(u access.UserContext, res access.Resource, act Action) string {
	if u.Admin {
		return ScopeAll
	}
	if scope, ok := overrideScope(u, res, act); ok {
		return scope
	}
	return m.ScopeFor(u.Preset, res, act)
}

//nolint:gochecknoglobals // resource codex (stable dictionary, mirrors V9)
var resourceNames = map[access.Resource]string{
	access.ResourceProject:      resProject,
	access.ResourceProcess:      resProcess,
	access.ResourceTask:         resTask,
	access.ResourceMilestone:    resMilestone,
	access.ResourceAssignment:   resAssignment,
	access.ResourceState:        resState,
	access.ResourceResource:     resResource,
	access.ResourceWorker:       resWorker,
	access.ResourceComment:      resComment,
	access.ResourceUserCatalog:  resUserCatalog,
	access.ResourceRBACConfig:   resRBACConfig,
	access.ResourceUserAdmin:    resUserAdmin,
	access.ResourceStateAdmin:   resStateAdmin,
	access.ResourceOrgStructure: resOrgStructure,
	access.ResourceAudit:        resAudit,
	access.ResourceAutoCreate:   resAutoCreate,
}

//nolint:gochecknoglobals // action codex
var actionNames = map[Action]string{
	ActionView:       actView,
	ActionCreate:     actCreate,
	ActionUpdate:     actUpdate,
	ActionDelete:     actDelete,
	ActionPrioritize: actPrioritize,
}

// ResourceName returns the string resource code ("" — unknown).
func ResourceName(res access.Resource) string { return resourceNames[res] }

// ParseResource parses a string resource code.
func ParseResource(s string) (access.Resource, bool) {
	for res, name := range resourceNames {
		if name == s {
			return res, true
		}
	}
	return 0, false
}

// ActionName returns the string action code ("" — unknown).
func ActionName(act Action) string { return actionNames[act] }

// ParseAction parses a string action code.
func ParseAction(s string) (Action, bool) {
	for act, name := range actionNames {
		if name == s {
			return act, true
		}
	}
	return 0, false
}

// ScopeName returns the canonical expression of a scope value (identity).
func ScopeName(scope string) string { return scope }
