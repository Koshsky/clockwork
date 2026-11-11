package domain

import "time"

// RoutePolicy — a route policy definition (kind + parameters).
type RoutePolicy struct {
	Name      string         `json:"name"`
	Kind      string         `json:"kind"`
	Params    map[string]any `json:"params"`
	Active    bool           `json:"active"`
	UpdatedBy *int64         `json:"updated_by"`
	UpdatedAt time.Time      `json:"updated_at"`
}
