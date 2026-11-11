package engine

// Scope-expression language: parsing, canonicalization of legacy zones and
// per-resource applicability (the ownership tree — tree.go); evaluation lives
// in eval.go, SQL generation in sqlscope.go. A rule's scope is an EXPRESSION
// over tree moves (self/up[N]/down[N]/sib/all/none).

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// Tree-move codes of a scope expression.
const (
	moveSelf       = "self"
	moveUp         = "up"
	moveDown       = "down"
	moveSib        = "sib"
	moveProjectSib = "sib_project"
)

// moveToken — one parsed move of an expression.
type moveToken struct {
	kind  string // moveSelf | moveUp | moveDown | moveSib
	depth int    // >0 for upN/downN; 0 — unbounded
}

// parsedScope — the parsed form of a scope expression.
type parsedScope struct {
	all   bool // "all" — unconditional access
	none  bool // ownerModeNone — explicit deny (""/absent rule is ScopeNone too)
	moves []moveToken
	canon string // canonical expression string
}

var moveRe = regexp.MustCompile(
	`^(self|up|down|sib|sib_project|project_owner|process_owner|process_projects|project_resources)(\d*)$`,
)

// parseScope parses a scope expression (or a legacy zone code) into the
// canonical form. Legacy aliases: own -> self, parent -> up1, ancestor -> up.
// Returns ok=false for malformed expressions.
func parseScope(s string) (parsedScope, bool) {
	raw := strings.TrimSpace(s)
	switch raw {
	case "":
		return parsedScope{}, true // missing rule = no access
	case "none":
		return parsedScope{none: true, canon: ownerModeNone}, true
	case "all":
		return parsedScope{all: true, canon: "all"}, true
	}
	// Legacy aliases.
	switch raw {
	case "own":
		return parsedScope{moves: []moveToken{{kind: moveSelf}}, canon: ScopeOwn}, true
	case "parent":
		return parsedScope{moves: []moveToken{{kind: moveUp, depth: 1}}, canon: ScopeParent}, true
	case "ancestor":
		return parsedScope{moves: []moveToken{{kind: moveUp}}, canon: ScopeAncestor}, true
	}
	out := parsedScope{}
	for tok := range strings.FieldsSeq(raw) {
		m := moveRe.FindStringSubmatch(tok)
		if m == nil {
			return parsedScope{}, false
		}
		kind := m[1]
		mt := moveToken{kind: kind}
		switch kind {
		case moveUp, moveDown:
			if m[2] != "" {
				n, err := strconv.Atoi(m[2])
				if err != nil || n < 1 {
					return parsedScope{}, false
				}
				mt.depth = n
			}
		case moveSelf, moveSib, moveProjectSib, ScopeProjectOwner, ScopeProcessOwner,
			ScopeProcessProjects, ScopeProjectResources:
			if m[2] != "" {
				return parsedScope{}, false
			}
		}
		out.moves = append(out.moves, mt)
	}
	if len(out.moves) == 0 {
		return parsedScope{}, false
	}
	out.canon = canonicalOf(out.moves)
	return out, true
}

// canonicalOf renders the canonical expression of an ordered move set.
func canonicalOf(moves []moveToken) string {
	parts := make([]string, 0, len(moves))
	for _, m := range moves {
		switch m.kind {
		case moveSelf:
			parts = append(parts, "self")
		case moveSib, moveProjectSib, ScopeProjectOwner, ScopeProcessOwner, ScopeProcessProjects, ScopeProjectResources:
			parts = append(parts, m.kind)
		case moveUp, moveDown:
			if m.depth > 0 {
				parts = append(parts, fmt.Sprintf("%s%d", m.kind, m.depth))
			} else {
				parts = append(parts, m.kind)
			}
		}
	}
	return strings.Join(parts, " ")
}

// ParseScope parses and canonicalizes a scope value (legacy zones included).
// An empty string is allowed and means "no access" (absent rule); anything
// else must be a valid expression. Returns ("", false) for malformed input.
func ParseScope(s string) (string, bool) {
	p, ok := parseScope(s)
	if !ok {
		return "", false
	}
	return p.canon, true
}

// ValidateScopeExpr validates a scope expression string against a resource.
func ValidateScopeExpr(expr string, res rbac.Resource) error {
	p, ok := parseScope(expr)
	if !ok {
		return fmt.Errorf("недопустимое выражение области %q", expr)
	}
	if p.none || expr == "" {
		// "none"/absent rules are not stored (absence of a row = no access).
		return fmt.Errorf("пустое или запрещающее выражение области %q не хранится", expr)
	}
	if p.all {
		return nil
	}
	for _, m := range p.moves {
		if !moveApplicable(m, res) {
			return fmt.Errorf(
				"перемещение %q неприменимо к ресурсу %q",
				moveName(m), ResourceName(res),
			)
		}
	}
	return nil
}

func moveName(m moveToken) string {
	if m.depth > 0 {
		return fmt.Sprintf("%s%d", m.kind, m.depth)
	}
	return m.kind
}

// moveApplicable reports whether a tree move is meaningful for a resource.
// self — any resource with an own owner (L0); up/upN — the resource has a
// parent; sib — has a parent AND its own nodes bear owners (a sibling is a
// node of the same type — ownerless siblings could never be "owned");
// down/downN — owner-bearing descendants exist.
func moveApplicable(m moveToken, res rbac.Resource) bool {
	switch m.kind {
	case moveSelf:
		return nodeHasOwner[res] && res != rbac.ResourceProcess && res != rbac.ResourceTask
	case moveUp:
		return nodeHasParent[res]
	case moveSib:
		return nodeHasParent[res] && nodeHasOwner[res]
	case moveProjectSib:
		return res == rbac.ResourceTask
	case ScopeProjectOwner, ScopeProcessOwner:
		return res == rbac.ResourceProcess || res == rbac.ResourceTask ||
			res == rbac.ResourceMilestone || res == rbac.ResourceAssignment
	case ScopeProcessProjects:
		return res == rbac.ResourceProject
	case ScopeProjectResources:
		return res == rbac.ResourceResource
	case moveDown:
		return len(ownerDescendants[res]) > 0
	}
	return false
}

// ScopeApplicable reports whether a scope expression is applicable to a
// resource (rule validation on write and on load).
func ScopeApplicable(res rbac.Resource, scope string) bool {
	return ValidateScopeExpr(scope, res) == nil
}
