// Package dto — API contracts for RBAC policy administration.
package dto

import "time"

// PresetRuleInput — a permissions matrix row record.
type PresetRuleInput struct {
	Preset   string `json:"preset"   example:"vp"     binding:"required"`
	Resource string `json:"resource" example:"task"   binding:"required"`
	Action   string `json:"action"   example:"update" binding:"required"`
	Scope    string `json:"scope"    example:"parent" binding:"required"`
}

// PresetRuleView — a permissions matrix row.
type PresetRuleView struct {
	ID        int64     `json:"id"`
	Preset    string    `json:"preset"`
	Resource  string    `json:"resource"`
	Action    string    `json:"action"`
	Scope     string    `json:"scope"`
	UpdatedBy *int64    `json:"updated_by"`
	UpdatedAt time.Time `json:"updated_at"`
}

// RoutePolicyInput — a route policy record (kind + parameters).
type RoutePolicyInput struct {
	Name   string         `json:"name"   example:"task.create" binding:"required"`
	Kind   string         `json:"kind"   example:"create"      binding:"required"`
	Params map[string]any `json:"params"`
	Active *bool          `json:"active"`
}

// RoutePolicyView — a route policy view.
type RoutePolicyView struct {
	Name      string         `json:"name"`
	Kind      string         `json:"kind"`
	Params    map[string]any `json:"params"`
	Active    bool           `json:"active"`
	UpdatedBy *int64         `json:"updated_by"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// MatrixCell — one cell of the effective matrix (with the admin bypass). The
// API serves the COMPLETE grid: every catalog preset (plus admin) × every
// resource × every action, so the UI never has to guess what exists.
type MatrixCell struct {
	// Preset — the preset TAG (dp/rp/vp/worker/custom), never its display name.
	Preset string `json:"preset"`
	// Resource — the resource code from the engine dictionary.
	Resource string `json:"resource"`
	// Action — view/create/update/delete.
	Action string `json:"action"`
	// Scope — the canonical scope expression, or "none" when the preset holds
	// no right for the cell (an empty string would read as a granted right).
	Scope string `json:"scope"`
}

// ExplainInput — parameters of the "why allow/deny" check.
type ExplainInput struct {
	Preset       string `form:"preset"        binding:"required" example:"vp"`
	Resource     string `form:"resource"      binding:"required" example:"task"`
	Action       string `form:"action"        binding:"required" example:"update"`
	UserID       int64  `form:"user_id"                          example:"4"`
	ProjectOwner int64  `form:"project_owner"                    example:"3"`
	ProcessOwner int64  `form:"process_owner"                    example:"4"`
	Owner        int64  `form:"owner"`
}

// ExplainResult — a check result.
type ExplainResult struct {
	Scope   string `json:"scope"`
	Allowed bool   `json:"allowed"`
}

// Permission — a caller's principal right: an action on a resource is allowed
// (the scope from the matrix; the frontend derives the ownership zone from it).
type Permission struct {
	Inherited bool   `json:"inherited,omitempty"`
	Resource  string `json:"resource"            example:"project"`
	Action    string `json:"action"              example:"create"`
	Scope     string `json:"scope"               example:"own"`
}

// PermissionOverride — a per-user permission cell of the editor: an explicit
// grant (granted=true, scope) or revoke (granted=false, scope ignored).
type PermissionOverride struct {
	Resource string `json:"resource" example:"task"   binding:"required"`
	Action   string `json:"action"   example:"view"   binding:"required"`
	Scope    string `json:"scope"    example:"parent"`
	Granted  bool   `json:"granted"  example:"true"`
}

// UserPermissionsView — the per-user permissions of the editor: the assigned
// preset, the current overrides, the preset baseline (without overrides) and
// the resulting effective matrix.
type UserPermissionsView struct {
	UserID      int64                `json:"user_id"`
	Preset      *string              `json:"preset"`
	Admin       bool                 `json:"admin"`
	Overrides   []PermissionOverride `json:"overrides"`
	PresetScope []Permission         `json:"preset_scope"`
	Effective   []Permission         `json:"effective"`
}

// UserPermissionsInput — the full replacement set of a user's overrides.
type UserPermissionsInput struct {
	Overrides []PermissionOverride `json:"overrides"`
}

// PresetView — a preset catalog entry: tag (system access code, the identity
// referenced by users/rules), name (human-readable display name) and
// description.
type PresetView struct {
	ID          int64  `json:"id"`
	Tag         string `json:"tag"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// PresetUpsertInput — preset creation (tag = system access code).
type PresetUpsertInput struct {
	Tag         string `json:"tag"         example:"auditor"                     binding:"required"`
	Name        string `json:"name"        example:"Внешний аудит"               binding:"required"`
	Description string `json:"description" example:"Проверка годовой отчётности"`
}

// PresetUpdateInput — preset update: optional tag rename (Tag) plus the
// display name and description (always sent by the client).
type PresetUpdateInput struct {
	Tag         *string `json:"tag,omitempty" example:"auditor"`
	Name        string  `json:"name"          example:"Внешний аудит"`
	Description string  `json:"description"   example:"Проверка годовой отчётности"`
}
