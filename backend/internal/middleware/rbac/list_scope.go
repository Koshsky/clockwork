package rbac

// ListScope — the compiled scope-expression of a list request. Engine
// (engine.CompileListScope) translates the effective view expression of the
// caller (scopeexpr.go: all/self/up1/up/sib/down or the no-rule fallback)
// into this boolean bundle; the generated per-resource WHERE skeletons of the
// list queries consume it as boolean parameters. Repositories receive the
// bundle instead of a raw scope string so the queries stay static (sqlc).
type ListScope struct {
	ProjectView      []string
	ProcessView      []string
	TaskView         []string
	ProjectOwner     bool
	ProcessOwner     bool
	ProcessProjects  bool
	ProjectResources bool
	// All — unconditional access (expression "all").
	All bool
	// Self — the row owner (L0) is the caller.
	Self bool
	// Parent — the row's parent owner is the caller (up1).
	Parent bool
	// Ancestor — any owner of the row's chain is the caller (up).
	Ancestor bool
	// Sib — the caller owns a process in the same project, or a task in the same process.
	Sib bool
	// ProjectSib — a task belongs to a project containing a task of the caller.
	ProjectSib bool
	// Down — the caller owns a descendant node below the row.
	Down bool
	// None — the caller has no view rule (reference fallback: include all).
	None bool
}
