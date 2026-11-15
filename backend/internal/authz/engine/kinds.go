package engine

// These data types retain their public Swagger definition identities.
// HTTP construction and validation belong to middleware/rbac.

// RouteSpec — configurable definition of a route policy (kind + parameters).
// The mechanisms (builders) stay in code; the kind choice and parameters come from the DB.
type RouteSpec struct {
	Name   string
	Kind   string
	Params map[string]any
}

// ParamInfo describes a kind parameter (for the API and UI reference).
type ParamInfo struct {
	Key      string `json:"key"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

// KindInfo describes a kind for the API reference.
type KindInfo struct {
	Name   string      `json:"name"`
	Params []ParamInfo `json:"params"`
}
