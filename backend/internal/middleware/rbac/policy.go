// Package rbac is the policy engine. The rules themselves (the role matrix,
// condition builders and route policies) live in the policies subpackage.
package rbac

// Resource is an entity access rights apply to.
type Resource int

const (
	ResourceProject Resource = iota
	ResourceProcess
	ResourceTask
	ResourceMilestone
	ResourceAssignment

	// ResourceState is an employee state reference.
	ResourceState
	// ResourceResource is a timesheet resource category (specialization).
	ResourceResource
	// ResourceWorker is a worker (user with role worker).
	ResourceWorker
	// ResourceComment is a task comment (threaded discussion on a task).
	ResourceComment

	// ResourceUserCatalog is a virtual resource: the user catalog (pickers).
	// No owner chain; access is decided by the matrix only.
	ResourceUserCatalog
	// ResourceRBACConfig controls permission administration.
	ResourceRBACConfig

	// ResourceUserAdmin is a virtual resource: the users admin section
	// (page guard), granted explicitly (admin gets it via the bypass).
	ResourceUserAdmin
	// ResourceStateAdmin is a virtual resource: the states admin section.
	ResourceStateAdmin
	// ResourceOrgStructure is a virtual resource: the org structure section.
	ResourceOrgStructure
	// ResourceAudit is a virtual resource: the audit-log admin section
	// (page guard), admin only (bypass).
	ResourceAudit
	// ResourceAutoCreate controls the new-project template independently of RBAC.
	ResourceAutoCreate
)

// Owners is an entity's chain of owners: the project owner and the process owner.
// For a project, ProcessOwner is empty; for a process, the owners of its parent
// and of itself; for a task/milestone/assignment, the owners of their process and
// project. For timesheet entities (resource/employee), the Owner field holds the
// row owner.
type Owners struct {
	ProjectOwner  int64
	ProcessOwner  int64
	Owner         int64
	ResourceOwner int64
}

// SharesOwner reports whether the two entities share ownership for the
// cross-entity business rule ("a resource can only be assigned to a task of
// its own owner"). The access level (project/process owner) of the receiver
// is compared against any owner of the other side (including its row owner —
// a resource carries only a row owner). Row-owner against row-owner is NOT
// compared: letting task.owner_id == resource.owner_id match would bypass the
// process/project ownership check.
func (o Owners) SharesOwner(other Owners) bool {
	return o.sharesAccess(other.ProjectOwner) ||
		o.sharesAccess(other.ProcessOwner) ||
		o.sharesAccess(other.Owner)
}

// sharesAccess reports whether one of o's access-level owners equals v.
func (o Owners) sharesAccess(v int64) bool {
	return v != 0 && (o.ProjectOwner == v || o.ProcessOwner == v)
}
