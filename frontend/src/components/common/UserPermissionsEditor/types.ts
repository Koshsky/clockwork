/**
 * Types of the UserPermissionsEditor — per-user permission overrides.
 * Mirrors the backend DTO shapes (without importing the generated @/api client
 * — components must not depend on it).
 */

/** A per-user override: an explicit grant (granted, scope) or revoke
 * (granted=false, scope ignored) that shadows the preset rule for the same
 * (resource, action). */
export interface PermissionOverride {
  resource: string
  action: string
  scope?: string
  granted: boolean
}

/** A single effective/baseline permission (from the preset or the final view). */
export interface PermissionCell {
  resource: string
  action: string
  scope: string
}

/** The editor's data model — what the backend returns for a user. */
export interface UserPermissionsModel {
  preset: string | null
  admin: boolean
  overrides: PermissionOverride[]
  presetScope: PermissionCell[]
  effective: PermissionCell[]
}

/** Editor state passed up to the parent (the staged override set). */
export interface UserPermissionsDraft {
  overrides: PermissionOverride[]
  dirty: boolean
}