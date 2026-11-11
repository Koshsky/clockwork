package engine

// Runtime access decisions over the Casbin snapshot: scope resolution for the
// caller (preset + per-user overrides + admin bypass), entity authorization
// (zone evaluation in Go + the ABAC presence matcher) and the route-check
// entry points (EnforceTarget).
//
// Zone evaluation moved out of the Casbin model: the effective scope EXPRESSION
// of the caller is evaluated in Go (EvalScope, chain + optional owner probes)
// BEFORE the presence check; the matcher only verifies that an allow row
// exists without a deny (plus the author_or / owner_match business legs).

import (
	"context"
	"strconv"
	"strings"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// Policy effect codes of the Casbin rows.
const (
	eftAllow = "allow"
	eftDeny  = "deny"
)

// Initial capacity of the assembled matrix rule slice.
const matrixInitCap = 64

// resActKey returns the canonical "<resource>/<action>" policy object.
func resActKey(res rbac.Resource, act Action) string {
	return ResourceName(res) + "/" + ActionName(act)
}

// splitKey parses a canonical "<resource>/<action>" object.
func splitKey(key string) (rbac.Resource, Action, error) {
	resName, actName, found := strings.Cut(key, "/")
	if !found {
		return 0, 0, errInvalidKey(key)
	}
	res, okRes := ParseResource(resName)
	if !okRes {
		return 0, 0, errInvalidKey(key)
	}
	act, okAct := ParseAction(actName)
	if !okAct || !ActionApplicable(res, act) {
		return 0, 0, errInvalidKey(key)
	}
	return res, act, nil
}

func errInvalidKey(key string) error {
	return &invalidKeyError{key: key}
}

// invalidKeyError — a malformed or unknown "<resource>/<action>" object.
type invalidKeyError struct {
	key string
}

func (e *invalidKeyError) Error() string {
	return "неизвестный объект доступа " + strconv.Quote(e.key)
}

// numericSub reports whether a policy subject is a user id (the ACL rows) as
// opposed to a preset name (the matrix rows).
func numericSub(sub string) bool {
	if sub == "" {
		return false
	}
	_, err := strconv.ParseInt(sub, 10, 64)
	return err == nil
}

// enforcePresence runs the ABAC presence matcher (allow row + no deny; the
// zone was already evaluated Go-side). The admin bypass is a code-level
// invariant (deny rows must not affect admins).
func (s *Snapshot) enforcePresence(sub Subject, obj Object) bool {
	if sub.Admin {
		return true
	}
	allowed, err := s.e.Enforce(sub, obj)
	if err != nil {
		return false
	}
	return allowed
}

// CurrentMatrix returns the effective preset matrix assembled from the Casbin
// allow rows (the matrix/explain API source; admin bypass is not stored).
func CurrentMatrix() Matrix {
	rules := make([]MatrixRule, 0, matrixInitCap)
	rows, err := current().e.GetPolicy()
	if err != nil {
		return NewMatrix(rules)
	}
	for _, row := range rows {
		if len(row) < 4 || row[3] != eftAllow || numericSub(row[0]) {
			continue
		}
		res, act, keyErr := splitKey(row[1])
		if keyErr != nil {
			continue
		}
		scope, ok := ParseScope(row[2])
		if !ok || scope == ScopeNone || scope == ownerModeNone {
			continue
		}
		rules = append(rules, MatrixRule{Res: res, Act: act, Role: row[0], Scope: scope})
	}
	return NewMatrix(rules)
}

// scopeFor resolves the preset scope expression (admin gets ScopeAll — invariant).
func scopeFor(role string, res rbac.Resource, act Action) string {
	if role == userdomain.PresetAdmin {
		return ScopeAll
	}
	rows, err := current().e.GetFilteredPolicy(0, role, resActKey(res, act))
	if err != nil || len(rows) == 0 {
		return ScopeNone
	}
	scope, ok := ParseScope(rows[0][2])
	if !ok {
		return ScopeNone
	}
	return scope
}

// scopeForUser resolves the caller's effective scope expression: admin —
// ScopeAll; a user-level deny (p2) — ScopeNone; a user-level grant — its
// expression; otherwise the preset expression through the role hierarchy (g).
func scopeForUser(u userctx.UserContext, res rbac.Resource, act Action) string {
	if u.Admin {
		return ScopeAll
	}
	s := current()
	key := resActKey(res, act)
	uid := strconv.FormatInt(u.ID, 10)

	// A user-level revoke (eft deny on the same (sub, obj)) shadows both the
	// user grants and the preset rows.
	if rows, err := s.e.GetFilteredPolicy(0, uid, key); err == nil {
		for _, row := range rows {
			if len(row) >= 4 && row[3] == eftDeny {
				return ScopeNone
			}
		}
	}
	if scope, ok := implicitScope(s, key, uid); ok {
		return scope
	}
	// Direct preset row fallback (mirrors the matcher's p.sub == r.sub.Role):
	// useful before the grouping rows are loaded (tests, tooling) — the preset
	// row itself is authoritative for the role.
	if rows, err := s.e.GetFilteredPolicy(0, u.Preset, key); err == nil {
		for _, row := range rows {
			if len(row) >= 4 && row[3] == eftAllow {
				if scope, ok := ParseScope(row[2]); ok {
					return scope
				}
			}
		}
	}
	return ScopeNone
}

// implicitScope scans the caller's implicit permissions (preset through g +
// user-level rows): a user-level grant wins; otherwise the preset's row is
// the fallback. ok=false — nothing found.
func implicitScope(s *Snapshot, key, uid string) (string, bool) {
	perms, err := s.e.GetImplicitPermissionsForUser(uid)
	if err != nil {
		return ScopeNone, false
	}
	fallback := ScopeNone
	for _, p := range perms {
		if len(p) < 4 || p[1] != key || p[3] != eftAllow {
			continue
		}
		scope, ok := ParseScope(p[2])
		if !ok {
			continue
		}
		if p[0] == uid {
			return scope, true // a user-level grant wins over the preset
		}
		fallback = scope
	}
	if fallback != ScopeNone {
		return fallback, true
	}
	return ScopeNone, false
}

// ScopeForUser returns the caller's effective scope expression (admin bypass +
// per-user overrides applied; Casbin snapshot).
func ScopeForUser(u userctx.UserContext, res rbac.Resource, act Action) string {
	return scopeForUser(u, res, act)
}

// Can reports whether a preset can perform an action at all.
func Can(role string, res rbac.Resource, act Action) bool {
	return scopeFor(role, res, act) != ScopeNone
}

// CanUser reports whether the caller can perform an action at all.
func CanUser(u userctx.UserContext, res rbac.Resource, act Action) bool {
	return scopeForUser(u, res, act) != ScopeNone || (act == ActionView && hasViewAncestor(u, res))
}

// ViewScopeCode returns the view scope expression of a preset for listing
// requests (canonical: all | none-ish "" | self | up1 | up | region). The
// list-scope compiler (sqlscope.go CompileViewScopeUser) turns it into the
// boolean bundle the SQL skeletons consume.
func ViewScopeCode(role string, res rbac.Resource) string {
	return scopeFor(role, res, ActionView)
}

// ViewScopeCodeUser returns the caller's view scope expression for listing
// requests (admin bypass + per-user overrides applied).
func ViewScopeCodeUser(u userctx.UserContext, res rbac.Resource) string {
	return scopeForUser(u, res, ActionView)
}

// Authorize reports whether a preset may perform an action on an entity with
// its owners (the preset introspection path: effective expression + chain
// evaluation; per-user overrides do not apply).
func Authorize(role string, res rbac.Resource, act Action, owners rbac.Owners, userID int64) bool {
	if role == userdomain.PresetAdmin {
		return true
	}
	scope := scopeFor(role, res, act)
	if scope == ScopeNone {
		return false
	}
	return authorizeScope(scope, res, owners, userID)
}

// AuthorizeUser reports whether the caller may perform an action on an entity
// with its owners (admin bypass + per-user overrides applied; zone = the
// effective expression + chain; presence via the Casbin snapshot).
func AuthorizeUser(u userctx.UserContext, res rbac.Resource, act Action, owners rbac.Owners, userID int64) bool {
	if u.Admin {
		return true
	}
	scope := scopeForUser(u, res, act)
	if scope == ScopeNone {
		return false
	}
	if !EvalScope(context.TODO(), scope, res, owners, userID, 0, nil) {
		return false
	}
	return current().enforcePresence(
		Subject{ID: itoa(userID), Role: u.Preset, Admin: u.Admin},
		buildObject(res, act, owners, "", 0, rbac.Owners{}),
	)
}

// authorizeScope — the expression evaluation for an entity chain (the preset
// introspection mirror; legacy zones behave as before: self = own, up1 =
// parent, up = ancestor).
func authorizeScope(scope string, res rbac.Resource, owners rbac.Owners, userID int64) bool {
	return EvalScope(context.TODO(), scope, res, owners, userID, 0, nil)
}

// ownField returns the owner of the row itself (chain L0) for a resource
// (0 — the entity has no own owner: own is not applicable).
func ownField(res rbac.Resource, owners rbac.Owners) int64 {
	switch res {
	case rbac.ResourceProject:
		return owners.ProjectOwner
	case rbac.ResourceProcess:
		return owners.ProcessOwner
	case rbac.ResourceTask, rbac.ResourceResource, rbac.ResourceWorker:
		return owners.Owner
	case rbac.ResourceMilestone, rbac.ResourceAssignment, rbac.ResourceState,
		rbac.ResourceComment, rbac.ResourceUserCatalog, rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin, rbac.ResourceStateAdmin, rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return 0
	}
	return 0
}

// parentField returns the immediate parent owner for a resource
// (0 — the resource has no parent in the project → process → task/… hierarchy).
func parentField(res rbac.Resource, owners rbac.Owners) int64 {
	switch res {
	case rbac.ResourceProcess:
		return owners.ProjectOwner
	case rbac.ResourceTask, rbac.ResourceMilestone, rbac.ResourceAssignment:
		return owners.ProcessOwner
	case rbac.ResourceProject, rbac.ResourceState, rbac.ResourceResource,
		rbac.ResourceWorker, rbac.ResourceComment,
		rbac.ResourceUserCatalog, rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin, rbac.ResourceStateAdmin, rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return 0
	}
	return 0
}

// ancestorMatch reports whether the user matches any owner of the entity's
// ownership chain (the L0 row owner or any higher one). For process/milestone
// the self-owner is absent (Owners.Owner = 0) — then the process and project
// owners are considered.
func ancestorMatch(res rbac.Resource, owners rbac.Owners, userID int64) bool {
	if userID == 0 {
		return false
	}
	switch res {
	case rbac.ResourceTask, rbac.ResourceMilestone, rbac.ResourceAssignment,
		rbac.ResourceProcess:
		return owners.Owner == userID || owners.ProcessOwner == userID || owners.ProjectOwner == userID
	case rbac.ResourceProject, rbac.ResourceState, rbac.ResourceResource,
		rbac.ResourceWorker, rbac.ResourceComment,
		rbac.ResourceUserCatalog, rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin, rbac.ResourceStateAdmin, rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return false
	}
	return false
}

// Target — a route-check target assembled by the kind builders: the implied
// (resource, action), the resolved owner chain, the entity id (for data
// dependent moves) and the special route modes.
type Target struct {
	Res    rbac.Resource
	Act    Action
	Owners rbac.Owners
	Mode   string
	// AuthorID — the author leg of ModeAuthorOr.
	AuthorID int64
	// OwnerB — the compared owner chain of ModeOwnerMatch.
	OwnerB rbac.Owners
	// ID — the target entity id (for sib/down probes; 0 — not applicable).
	ID int64
	// ParentID authorizes creation and moves against the resolved destination.
	ParentID      int64
	ProposedOwner int64
	ParentVisible bool
	// Ctx — the request context (for the owner probes).
	Ctx context.Context
}

// EnforceTarget runs the route authorization: the caller's effective scope
// expression evaluated over the owner chain (+ probes when the target carries
// an id/context) and the Casbin presence check. The author_or mode skips the
// zone pre-check for the author leg — the author is allowed regardless of the
// parent's zone (the matcher enforces the disjunction).
func EnforceTarget(u userctx.UserContext, t Target) bool {
	if !ActionApplicable(t.Res, t.Act) {
		return false
	}
	if u.Admin {
		return true
	}
	if t.Act == ActionView && inheritedView(u, t) {
		return true
	}
	return enforceDirectTarget(u, t)
}

func enforceDirectTarget(u userctx.UserContext, t Target) bool {
	if t.Res == rbac.ResourceAssignment && t.Act == ActionView &&
		scopeForUser(u, t.Res, t.Act) == ScopeParent &&
		(t.Owners.Owner != u.ID || t.Owners.ResourceOwner != u.ID) {
		return false
	}
	if t.Mode != ModeAuthorOr || t.AuthorID != u.ID {
		scope := scopeForUser(u, t.Res, t.Act)
		if scope == ScopeNone {
			return false
		}
		probe := currentProbe()
		if !evalTargetScope(t, scope, u.ID, probe) {
			return false
		}
	}
	obj := buildObject(t.Res, t.Act, t.Owners, t.Mode, t.AuthorID, t.OwnerB)
	return current().enforcePresence(
		Subject{ID: itoa(u.ID), Role: u.Preset, Admin: u.Admin},
		obj,
	)
}

// buildObject maps an owner chain into the object's ABAC attributes by the
// resource's zone semantics (mirror ownField/parentField; the ancestor zone
// uses the full chain; the zone leg itself is evaluated Go-side).
func buildObject(
	res rbac.Resource,
	act Action,
	owners rbac.Owners,
	mode string,
	authorID int64,
	ownerB rbac.Owners,
) Object {
	return Object{
		Key:            resActKey(res, act),
		Mode:           mode,
		OwnerID:        itoa(ownField(res, owners)),
		ParentOwnerID:  itoa(parentField(res, owners)),
		ProcessOwnerID: itoa(owners.ProcessOwner),
		ProjectOwnerID: itoa(owners.ProjectOwner),
		AuthorID:       itoa(authorID),
		OwnerA:         owners,
		OwnerB:         ownerB,
	}
}

// itoa returns the decimal string of a user/owner id ("" — 0: not set).
func itoa(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}

// HasViewAncestor reports potential inherited visibility, independently from direct child denials.
func HasViewAncestor(u userctx.UserContext, res rbac.Resource) bool {
	return hasViewAncestor(u, res)
}

func hasViewAncestor(u userctx.UserContext, res rbac.Resource) bool {
	for _, parent := range viewAncestors(res) {
		if scopeForUser(u, parent, ActionView) != ScopeNone {
			return true
		}
	}
	return false
}

func viewAncestors(res rbac.Resource) []rbac.Resource {
	switch res {
	case rbac.ResourceProcess:
		return []rbac.Resource{rbac.ResourceProject}
	case rbac.ResourceTask, rbac.ResourceMilestone:
		return []rbac.Resource{rbac.ResourceProject, rbac.ResourceProcess}
	case rbac.ResourceAssignment:
		return []rbac.Resource{rbac.ResourceProject, rbac.ResourceProcess, rbac.ResourceTask}
	case rbac.ResourceProject,
		rbac.ResourceState,
		rbac.ResourceResource,
		rbac.ResourceWorker,
		rbac.ResourceComment,
		rbac.ResourceUserCatalog,
		rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin,
		rbac.ResourceStateAdmin,
		rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return nil
	}
	return nil
}

func inheritedView(u userctx.UserContext, target Target) bool {
	probe := currentProbe()
	if probe == nil || probe.Parents == nil || target.ID == 0 {
		return false
	}
	parents, err := probe.Parents(target.Ctx, target.Res, target.ID)
	if err != nil {
		return false
	}
	for _, parent := range parents {
		parent.Act = ActionView
		parent.Ctx = target.Ctx
		if enforceDirectTarget(u, parent) {
			return true
		}
	}
	return false
}

func unrestrictedViewAncestor(u userctx.UserContext, res rbac.Resource) bool {
	for _, parent := range viewAncestors(res) {
		if scopeForUser(u, parent, ActionView) == ScopeAll {
			return true
		}
	}
	return false
}
