/**
 * Rights grid of the permissions screens, derived from the backend payload.
 *
 * `GET /rbac/matrix` serves the COMPLETE effective matrix — every preset ×
 * every resource × every action, with "none" where the preset holds no right.
 * The grid is therefore built FROM the payload instead of a frontend list: a
 * resource or action the engine gains shows up on its own, and no right can be
 * hidden by a stale hardcoded dictionary. The local dictionaries only supply
 * presentation (section order, titles, scope chips).
 */

import { canonicalScope, scopeMoves } from '@/rbacScope'

/** Wire code of "no right" in a matrix cell. */
export const NO_ACCESS = 'none'

/** Minimal shape of a matrix cell (the generated DTO). */
export interface MatrixCellLike {
  preset?: string | null
  resource?: string | null
  action?: string | null
  scope?: string | null
}

/** A rendered section of the grid. */
export interface GridSection {
  key: string
  resources: string[]
}

/** Key of a matrix cell (also the key of a staged edit). */
export function cellKey(preset: string, resource: string, action: string): string {
  return `${preset}|${resource}|${action}`
}

/**
 * Scope of a cell, normalized: an empty/absent value means no right, and it
 * must read as NO_ACCESS — `?? 'none'` alone would let an empty string through
 * and the cell would look granted.
 */
export function cellScope(
  cells: readonly MatrixCellLike[],
  preset: string,
  resource: string,
  action: string,
): string {
  for (const cell of cells) {
    if (cell.preset === preset && cell.resource === resource && cell.action === action) {
      return cell.scope ? cell.scope : NO_ACCESS
    }
  }
  return NO_ACCESS
}

/** Effective scope per cell key (no rule = NO_ACCESS). */
export function scopeByCell(cells: readonly MatrixCellLike[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const cell of cells) {
    if (!cell.preset || !cell.resource || !cell.action) continue
    map[cellKey(cell.preset, cell.resource, cell.action)] = cell.scope ? cell.scope : NO_ACCESS
  }
  return map
}

/** Resources present in the payload, in payload order (the engine enum order). */
export function gridResources(cells: readonly MatrixCellLike[]): string[] {
  const out: string[] = []
  for (const cell of cells) {
    if (cell.resource && !out.includes(cell.resource)) out.push(cell.resource)
  }
  return out
}

/**
 * Actions present in the payload, ordered by `preferredOrder`; anything the
 * payload carries beyond that list is appended in payload order.
 */
export function gridActions(
  cells: readonly MatrixCellLike[],
  preferredOrder: readonly string[] = [],
): string[] {
  const present: string[] = []
  for (const cell of cells) {
    if (cell.action && !present.includes(cell.action)) present.push(cell.action)
  }
  const ordered = preferredOrder.filter((a) => present.includes(a))
  return [...ordered, ...present.filter((a) => !ordered.includes(a))]
}

/**
 * Sections of the grid: the known groups (in their declared order, empty ones
 * dropped) followed by one fallback section holding every resource the groups
 * do not mention. The fallback is what keeps a backend-side addition visible.
 */
export function gridSections(
  cells: readonly MatrixCellLike[],
  groups: ReadonlyArray<{ key: string; resources: readonly string[] }>,
  fallbackKey = 'other',
): GridSection[] {
  const resources = gridResources(cells)
  const known = new Set(groups.flatMap((g) => [...g.resources]))
  const sections: GridSection[] = []
  for (const group of groups) {
    const present = resources.filter((r) => group.resources.includes(r))
    if (present.length) sections.push({ key: group.key, resources: present })
  }
  const rest = resources.filter((r) => !known.has(r))
  if (rest.length) sections.push({ key: fallbackKey, resources: rest })
  return sections
}

export interface PresetActionGroup {
  key: string
  actions: string[]
  resource?: string
  title?: string
  description?: string
}

export function presetActionGroups(actions: readonly string[]): PresetActionGroup[] {
  const management = actions.filter((action) => ['create', 'update', 'delete'].includes(action))
  const groups = actions.filter((action) => !management.includes(action))
    .map((action) => ({ key: action, actions: [action] }))
  if (management.length) groups.push({ key: 'manage', actions: management })
  return groups
}

export function commonPresetScope(scopes: readonly string[]): string | null {
  const normalized = scopes.map((scope) => {
    if (!scope || scope === NO_ACCESS) return NO_ACCESS
    return scopeMoves(scope).join(' ') || canonicalScope(scope)
  })
  return normalized.length && normalized.every((scope) => scope === normalized[0]) ? normalized[0] : null
}
