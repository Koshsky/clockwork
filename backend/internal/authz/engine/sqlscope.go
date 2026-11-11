package engine

// List-scope SQL: the per-resource WHERE skeletons and the expression
// compiler. The skeletons are constants derived once from the ownership tree
// registry (tree.go) and spliced into the list queries (sqlc, static SQL);
// the compiler maps the caller's effective view EXPRESSION (scopeexpr.go) to
// the boolean bundle (middleware/rbac.ListScope) the skeletons read. Runtime
// values are only user ids — no SQL text interpolation of rules.

import (
	"strings"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// CompileListScope translates a scope expression (canonical) into the boolean
// ListScope bundle for the list queries. An absent rule ("") yields
// None=true — the reference-data fallback (include all); it is never produced
// for gated lists (the ListCheck middleware forbids "").
func CompileListScope(expr string, _ rbac.Resource) rbac.ListScope {
	p, ok := parseScope(expr)
	if !ok || p.none {
		return rbac.ListScope{None: true}
	}
	if p.all {
		return rbac.ListScope{All: true}
	}
	if len(p.moves) == 0 {
		return rbac.ListScope{None: true}
	}
	var s rbac.ListScope
	for _, m := range p.moves {
		switch m.kind {
		case ScopeProjectOwner:
			s.ProjectOwner = true
		case ScopeProcessOwner:
			s.ProcessOwner = true
		case ScopeProcessProjects:
			s.ProcessProjects = true
		case ScopeProjectResources:
			s.ProjectResources = true
		case moveSelf:
			s.Self = true
		case moveUp:
			if m.depth == 1 {
				s.Parent = true
			} else {
				s.Ancestor = true
			}
		case moveSib:
			s.Sib = true
		case moveProjectSib:
			s.ProjectSib = true
		case moveDown:
			s.Down = true
		}
	}
	return s
}

// CompileViewScopeUser returns the caller's compiled view scope for a
// resource (admin bypass + per-user overrides applied) — the value passed
// into the list queries.
func CompileViewScopeUser(u userctx.UserContext, res rbac.Resource) rbac.ListScope {
	scope := CompileListScope(scopeForUser(u, res, ActionView), res)
	if hasViewAncestor(u, res) {
		scope.None = false
		scope.ProjectView = viewTokens(u, rbac.ResourceProject)
		scope.ProcessView = viewTokens(u, rbac.ResourceProcess)
		scope.TaskView = viewTokens(u, rbac.ResourceTask)
	}
	return scope
}

// ---------------------------------------------------------------------------
// Per-resource WHERE skeletons (spliced into the .sql list queries).
// Placeholder parameters (@sc_all/@sc_self/@sc_parent/@sc_ancestor/@sc_sib/
//	@sc_down/@sc_none/@user_id)	are boolean/bigint bind values filled from
// rbac.ListScope + the caller id. Alias conventions match the query files:
//   - tasks: t (task), p (process), pr (project)
//   - processes: p, pr
//   - projects: no alias (the from-list table is "projects")
//   - milestones: m, p, pr
//   - assignments: (a,) t, p, pr
//   - resources: r.* or plain owner_id
//   - users: plain manager_id
// ---------------------------------------------------------------------------

// ScopeProject — for queries listing projects (self = row owner; down = an
// owned process or task below the project; subtasks are task rows too).
const ScopeProject = `(
    @sc_all::boolean OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    (@sc_process_projects::boolean AND EXISTS (
        SELECT 1 FROM processes vp WHERE vp.project_id = projects.id AND vp.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND (EXISTS (
        SELECT 1 FROM processes dp
        WHERE dp.project_id = projects.id AND dp.owner_id = @user_id::bigint
    ) OR EXISTS (
        SELECT 1 FROM tasks d
        JOIN processes dp ON dp.id = d.process_id
        WHERE dp.project_id = projects.id AND d.owner_id = @user_id::bigint
    ))) OR
    @sc_none::boolean
  )`

// ScopeProcess — for queries listing processes (aliases p/pr).
const ScopeProcess = `(
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM processes s
        WHERE s.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.process_id = p.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )`

// ScopeProcessTaskScope — the TASK-scope process list (planning): the scope
// expression comes from the TASK view matrix, evaluated against PROCESS rows.
// Semantics preserved from the legacy task-scope list: 'own' (self) — a task
// of the user hangs under the process; 'parent' (up1) — the process owner is
// the user; 'ancestor' (up) — the chain; 'sib'/'down' — the generic tree
// moves.
const ScopeProcessTaskScope = `(
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.process_id = p.id AND t.owner_id = @user_id::bigint
    )) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = p.id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d
        WHERE d.process_id = p.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )`

// ScopeTask — for queries listing tasks (aliases t/p/pr).
const ScopeTask = `(
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND t.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = t.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = t.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )`

// ScopeMilestone — for queries listing milestones (aliases m/p/pr).
// self/sib/down are inapplicable (milestones carry no owner; siblings have
// no owners either).
const ScopeMilestone = `(
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    @sc_none::boolean
  )`

// ScopeAssignment — for queries listing assignments (aliases t/p/pr).
// self/sib/down are inapplicable (assignments carry no owner).
const ScopeAssignment = `(
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    @sc_none::boolean
  )`

// ScopeResource — for queries listing resources (alias r or plain).
// Only self (row owner) applies; the None fallback keeps the reference-data
// behavior (a caller without a resource rule sees the whole catalog).
const ScopeResource = `(
    @sc_all::boolean OR
    (@sc_project_resources::boolean AND EXISTS (
        SELECT 1 FROM processes rp JOIN projects rpr ON rpr.id = rp.project_id
        WHERE rp.owner_id = resources.owner_id AND rpr.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    @sc_none::boolean
  )`

// ScopeResourceAliased — the same skeleton with the r. alias.
const ScopeResourceAliased = `(
    @sc_all::boolean OR
    (@sc_project_resources::boolean AND EXISTS (
        SELECT 1 FROM processes rp JOIN projects rpr ON rpr.id = rp.project_id
        WHERE rp.owner_id = r.owner_id AND rpr.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND r.owner_id = @user_id::bigint) OR
    @sc_none::boolean
  )`

// ScopeUser — for queries listing users/workers (own = manager_id =
// caller): the worker tree root.
const ScopeUser = `(
    @sc_all::boolean OR
    (@sc_self::boolean AND manager_id = @user_id::bigint) OR
    @sc_none::boolean
  )`

func viewTokens(u userctx.UserContext, res rbac.Resource) []string {
	canonical, ok := ParseScope(scopeForUser(u, res, ActionView))
	if !ok {
		return nil
	}
	return strings.Fields(canonical)
}
