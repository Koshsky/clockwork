package engine

// Scope-expression evaluation for a single entity: the caller may access the
// entity when the effective expression is satisfied — the caller owns at least
// one node reachable from the entity by the expression's moves. Owner-chain
// moves (self/upN/up) use the Owners chain; data-dependent moves (sib/down)
// use the optional probes (nil — evaluate to false).

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// OwnerProbe — the data-dependent questions of scope evaluation (need the DB):
//   - descendant — does uid own a node below (res, id) in the tree?
//   - peer — does uid own a process/task in the selected shared group?
type OwnerProbe struct {
	Parents    func(ctx context.Context, res rbac.Resource, id int64) ([]Target, error)
	Related    func(ctx context.Context, target Target, userID int64, scope string) (bool, error)
	Descendant func(ctx context.Context, res rbac.Resource, id, userID int64) (bool, error)
	Peer       func(ctx context.Context, target Target, userID int64, project bool) (bool, error)
}

// evalOwnerChain — chain-based evaluation of one move (self/up1/up) against
// the entity's owner chain.
func evalChainMove(m moveToken, res rbac.Resource, owners rbac.Owners, uid int64) bool {
	if uid == 0 {
		return false
	}
	switch m.kind {
	case moveSelf:
		return ownField(res, owners) == uid
	case moveUp:
		// up1 — the immediate parent owner; up (any depth) / upN — any chain
		// owner (the project→process→task chain is ≤3 levels, so up2 == up).
		if m.depth == 1 {
			return parentField(res, owners) == uid
		}
		return ancestorMatch(res, owners, uid)
	}
	return false
}

// EvalScope — evaluation of a scope expression against an entity: chain moves
// from Owners, sib/down via the probes (nil probe → the move grants nothing).
func EvalScope(
	ctx context.Context,
	expr string,
	res rbac.Resource,
	owners rbac.Owners,
	uid int64,
	id int64,
	probe *OwnerProbe,
) bool {
	return evalTargetScope(Target{Res: res, Owners: owners, ID: id, Ctx: ctx}, expr, uid, probe)
}

func evalTargetScope(target Target, expr string, uid int64, probe *OwnerProbe) bool {
	p, ok := parseScope(expr)
	if !ok || p.none {
		return false
	}
	if p.all {
		return true
	}
	for _, m := range p.moves {
		if evalMove(m, target, uid, probe) {
			return true
		}
	}
	return false
}

// evalMove evaluates one move of an expression.
func evalMove(m moveToken, target Target, uid int64, probe *OwnerProbe) bool {
	if uid <= 0 {
		return false
	}
	switch m.kind {
	case moveSelf, moveUp:
		return evalChainMove(m, target.Res, target.Owners, uid)
	case ScopeProjectOwner:
		return target.Owners.ProjectOwner == uid
	case ScopeProcessOwner:
		return processOwnerMatch(target, uid)
	case ScopeProcessProjects, ScopeProjectResources:
		if probe != nil && probe.Related != nil && target.ID != 0 {
			ok, err := probe.Related(target.Ctx, target, uid, m.kind)
			return err == nil && ok
		}
	case moveDown:
		if probe != nil && probe.Descendant != nil && target.ID != 0 {
			ok, err := probe.Descendant(target.Ctx, target.Res, target.ID, uid)
			return err == nil && ok
		}
	case moveSib, moveProjectSib:
		if probe != nil && probe.Peer != nil && (target.ID != 0 || target.ParentID != 0) {
			ok, err := probe.Peer(target.Ctx, target, uid, m.kind == moveProjectSib)
			return err == nil && ok
		}
	}
	return false
}

func processOwnerMatch(target Target, uid int64) bool {
	if target.Res == rbac.ResourceProcess && target.Act == ActionCreate {
		return target.ProposedOwner == uid && target.ParentVisible
	}
	if target.Res == rbac.ResourceProcess && target.ParentID != 0 && !target.ParentVisible {
		return false
	}
	return target.Owners.ProcessOwner == uid
}
