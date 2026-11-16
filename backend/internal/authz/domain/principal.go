package domain

// PermissionRule is a per-user override of the preset rule for a
// (resource, action) pair: an explicit grant (Granted=true, Scope) or an
// explicit revoke (Granted=false, Scope ignored). A missing rule means the
// user falls back to the assigned preset; admin ignores all rules (bypass).
type PermissionRule struct {
	Resource string `json:"resource"`
	Action   string `json:"action"`
	Scope    string `json:"scope,omitempty"` // all|own|parent|ancestor (when granted)
	Granted  bool   `json:"granted"`
}

// UserContext is the authenticated user carried through the request, with the
// caller's effective rights resolved by the RBAC store (admin bypass, assigned
// preset and per-user overrides).
type UserContext struct {
	ID     int64  `json:"id"`
	Admin  bool   `json:"admin"`
	Preset string `json:"preset,omitempty"`
	// Rules are the caller's individual permission overrides
	// (see PermissionRule); nil — none.
	Rules    []PermissionRule `json:"rules,omitempty"`
	Email    string           `json:"email,omitempty"`
	FullName string           `json:"full_name,omitempty"`
	TenantID int64            `json:"tenant_id,omitempty"`
}
