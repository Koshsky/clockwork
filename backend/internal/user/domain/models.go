package domain

const (
	PresetAdmin           string = "admin"
	PresetProjectDirector string = "dp"
	PresetProjectManager  string = "rp"
	PresetProcessOwner    string = "vp"
	PresetWorker          string = "worker"
)

// UserPermission — an individual permission override of a user (created
// together with the account): an explicit grant (Granted=true, Scope) or
// revoke (Granted=false, Scope ignored) that shadows the preset rule for the
// same (resource, action).
type UserPermission struct {
	Resource string
	Action   string
	Scope    string
	Granted  bool
}
