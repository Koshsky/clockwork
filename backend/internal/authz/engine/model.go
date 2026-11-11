// Package engine is the access-control core of the ERP. It merges the former
// internal/policies rules (permission matrix, codecs, route-policy kinds) with
// the Casbin policy engine: RBAC role inheritance (user -> preset), ACL
// allow/deny policy rows (the matrix rules + per-user overrides) and an ABAC
// matcher that compares the caller's attributes (Subject) with the target's
// attributes (Object). The rules come from the Postgres policy tables via the
// internal/authz/service PolicyStore; the defaults here are the
// fallback/reset source.
//
// The ownership ZONE is NOT evaluated by the matcher anymore: the caller's
// effective scope expression (decision.go scopeForUser) is evaluated in Go
// (EvalScope — owner chain + optional data probes) before the presence check.
// The matcher only verifies that an allow row exists without a matching deny,
// plus the special business legs (author_or, owner_match).
package engine

import (
	"github.com/casbin/casbin/v2"
	"github.com/casbin/govaluate"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// modelText is the Casbin model.
//
//   - r.sub / r.obj are ABAC attribute structs (Subject/Object); p.sub is
//     either a preset (inherited through g) or a concrete user id (ACL).
//   - p carries the ownership scope expression of a (resource, action) grant
//     (informational/validation only — the zone is evaluated Go-side before
//     Enforce); p2 carries per-user revokes. The effect allows only when an
//     allow rule matched and no deny rule matched for the same (sub, obj).
//   - The first disjunct implements the author_or mode (the author always);
//     the owner_match mode is an additional ABAC leg (cross-entity owner
//     comparison).
const modelText = `
[request_definition]
r = sub, obj

[policy_definition]
p = sub, obj, scope, eft

[role_definition]
g = _, _

[policy_effect]
e = some(where (p_eft == allow)) && !some(where (p_eft == deny))

[matchers]
m = (p.eft == "allow" && r.obj.Mode == "author_or" && r.obj.AuthorID != "" && r.obj.AuthorID == r.sub.ID) || (r.obj.Key == p.obj && (p.sub == r.sub.ID || p.sub == r.sub.Role || g(r.sub.ID, p.sub) || g(r.sub.Role, p.sub)) && (p.eft == "deny" || (p.eft == "allow" && ((r.obj.Mode != "owner_match") || (r.obj.Mode == "owner_match" && eval(sharesOwner(r.obj.OwnerA, r.obj.OwnerB)))))))
`

// Route check modes of the object (special ABAC legs).
const (
	// ModeAuthorOr — the target is allowed when the caller authored it
	// (comment delete: the author always, others by the parent's right).
	ModeAuthorOr = "author_or"
	// ModeOwnerMatch — cross-entity rule: the target's owner chain must match
	// the compared entity (assignment create: the resource must belong to the
	// task's owner).
	ModeOwnerMatch = "owner_match"
)

// Subject is the caller's attribute bundle evaluated by the model (ABAC).
type Subject struct {
	// ID — the caller's user id ("" for pure-preset checks).
	ID string
	// Role — the caller's assigned preset ("" for pure-user checks).
	Role string
	// Admin — the admin bypass (checked in code before Enforce; kept here for
	// the model's defense-in-depth).
	Admin bool
}

// Object is the target's attribute bundle evaluated by the model (ABAC).
type Object struct {
	// Key — the canonical "<resource>/<action>" policy object.
	Key string
	// Mode — "" for standard checks, otherwise a special route mode.
	Mode string
	// OwnerID — the row owner (self).
	OwnerID string
	// ParentOwnerID — the immediate parent owner.
	ParentOwnerID string
	// ProcessOwnerID / ProjectOwnerID — the ancestor chain (mirrors the
	// Owners struct; informational for the model — the zone is Go-evaluated).
	ProcessOwnerID string
	ProjectOwnerID string
	// AuthorID — the author leg of the author_or mode.
	AuthorID string
	// OwnerA / OwnerB — the compared owner chains of the owner_match mode.
	OwnerA rbac.Owners
	OwnerB rbac.Owners
}

// Minimum number of arguments the owner-chain ABAC function accepts.
const minOwnersArgs = 2

// sharesOwnerFunc is the ABAC function backing eval(sharesOwner(...)): the
// cross-entity business rule ("a resource can only be assigned to a task of
// its own owner").
func sharesOwnerFunc(args ...any) (any, error) {
	if len(args) < minOwnersArgs {
		return false, nil
	}
	a, okA := args[0].(rbac.Owners)
	b, okB := args[1].(rbac.Owners)
	if !okA || !okB {
		return false, nil
	}
	return a.SharesOwner(b), nil
}

// registerFunctions attaches the ABAC functions to the enforcer.
func registerFunctions(e *casbin.Enforcer) {
	e.AddFunction("sharesOwner", govaluate.ExpressionFunction(sharesOwnerFunc))
}
