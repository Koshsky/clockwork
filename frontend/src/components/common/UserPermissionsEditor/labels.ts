/**
 * Shared dictionaries of the permission matrix UI: resources, actions, groups
 * and human-readable scope options (mirrors the backend scope applicability).
 *
 * The machine codes (resource keys, action codes, scope expressions such as
 * `self` / `up1` / `down`) are data; their human text lives in the message
 * catalog (`adminConfig.perm.*`) and is resolved through `t()` at CALL time —
 * never at module load, so a language switch re-renders the UI.
 */
import { t } from '@/i18n'
import { describeScopeExpr, scopeMoves } from '@/rbacScope'
import { gridActions, gridSections, presetActionGroups, type MatrixCellLike, type PresetActionGroup } from '@/utils/rbacGrid'

export interface ScopeOption {
  value: string
  /** Catalog key of the option label (resolved with `t('adminConfig.perm.zone.' + label)`). */
  label: string
  description?: string
}

/** Scope zone codes with human-readable labels in the resource context
 *  (mirrors the backend tree applicability: engine tree.go). The values are
 *  canonical expressions; the map is keyed by resource code. */
const SCOPE_CATALOG: Record<string, ScopeOption[]> = {
  project: [
    { value: 'process_projects', label: 'processProjects', description: 'processProjects' },
    { value: 'self', label: 'selfUpper' },
    { value: 'down', label: 'down', description: 'relatedProjects' },
    { value: 'all', label: 'all' },
  ],
  process: [
    { value: 'project_owner', label: 'exactProject', description: 'exactProject' },
    { value: 'process_owner', label: 'exactProcess', description: 'exactProcess' },
    { value: 'up1', label: 'up1Projects', description: 'projectOwner' },
    { value: 'up', label: 'projectOrProcessOwner', description: 'processOwnerChain' },
    { value: 'sib', label: 'sharedProject', description: 'sharedProcessProject' },
    { value: 'down', label: 'withEmployeeTasks', description: 'employeeTasks' },
    { value: 'all', label: 'all' },
  ],
  task: [
    { value: 'project_owner', label: 'exactProject', description: 'exactProject' },
    { value: 'process_owner', label: 'exactProcess', description: 'exactProcess' },
    { value: 'up1', label: 'up1Processes', description: 'processOwner' },
    { value: 'up', label: 'taskProcessOrProjectOwner', description: 'taskOwnerChain' },
    { value: 'sib', label: 'sharedProcess', description: 'sharedTaskProcess' },
    { value: 'sib_project', label: 'sharedProject', description: 'sharedTaskProject' },
    { value: 'down', label: 'withEmployeeSubtasks', description: 'employeeSubtasks' },
    { value: 'all', label: 'all' },
  ],
  milestone: [
    { value: 'project_owner', label: 'exactProject', description: 'exactProject' },
    { value: 'process_owner', label: 'exactProcess', description: 'exactProcess' },
    { value: 'up1', label: 'ownMilestones', description: 'processOwner' },
    { value: 'up', label: 'inEmployeeProjectsOrProcesses', description: 'processOwnerChain' },
    { value: 'all', label: 'all' },
  ],
  assignment: [
    { value: 'project_owner', label: 'exactProject', description: 'exactProject' },
    { value: 'process_owner', label: 'exactProcess', description: 'exactProcess' },
    { value: 'up1', label: 'ownAssignments', description: 'ownAssignment' },
    { value: 'up', label: 'taskProcessOrProjectOwner', description: 'assignmentOwnerChain' },
    { value: 'all', label: 'all' },
  ],
  state: [{ value: 'all', label: 'allStates' }],
  resource: [
    { value: 'project_resources', label: 'projectResources', description: 'projectResources' },
    { value: 'self', label: 'selfUpper' },
    { value: 'all', label: 'all' },
  ],
  worker: [
    { value: 'self', label: 'selfSubordinates' },
    { value: 'all', label: 'all' },
  ],
  user_catalog: [{ value: 'all', label: 'available' }],
  user_admin: [{ value: 'all', label: 'available' }],
  rbac_config: [{ value: 'all', label: 'available' }],
  auto_create: [{ value: 'all', label: 'available' }],
  // Page guards and derived resources: no owner, no parent — "all" only
  // (mirrors engine/tree.go: nodeHasOwner / nodeHasParent are false).
  state_admin: [{ value: 'all', label: 'available' }],
  org_structure: [{ value: 'all', label: 'available' }],
  audit: [{ value: 'all', label: 'available' }],
  comment: [{ value: 'all', label: 'available' }],
}

/** The first iteration exposes only direct owner relationships. */
const BASIC_SCOPES: Record<string, string[]> = {
  project: ['all', 'self', 'process_projects'],
  process: ['all', 'project_owner', 'process_owner'],
  task: ['all', 'project_owner', 'process_owner'],
  milestone: ['all', 'project_owner', 'process_owner'],
  assignment: ['all', 'project_owner', 'process_owner'],
  resource: ['all', 'self', 'project_resources'],
}

export const SCOPE_OPTIONS: Record<string, ScopeOption[]> = Object.fromEntries(
  Object.entries(SCOPE_CATALOG).map(([resource, options]) => [resource,
    BASIC_SCOPES[resource]
      ? BASIC_SCOPES[resource].map((code) => options.find((option) => option.value === code)!).filter(Boolean)
      : options,
  ]),
)

/** Equivalent legacy conditions share the same selected chip without rewriting stored rules. */
export function simpleScope(resource: string, scope: string): string {
  if (!scope || scope === 'all' || scope === 'none') return scope
  return scopeMoves(scope).map((move) => {
    if (move === 'up1' && resource === 'process') return 'project_owner'
    if (move === 'up1' && (resource === 'task' || resource === 'milestone')) return 'process_owner'
    return move
  }).join(' ')
}

export function hasAdditionalScope(resource: string, scope: string): boolean {
  const available = SCOPE_OPTIONS[resource] ?? FALLBACK_SCOPE_OPTIONS
  return scopeMoves(simpleScope(resource, scope)).some((move) => !available.some((option) => option.value === move))
}

/** Scope chips of a resource the dictionary does not describe: "all" is the
 *  one move applicable to every resource, so a resource added on the backend
 *  stays editable instead of rendering an empty chooser. */
export const FALLBACK_SCOPE_OPTIONS: readonly ScopeOption[] = [{ value: 'all', label: 'available' }]

/** Page sections of the matrix (`key` is the catalog key of the title). */
export const GROUPS: ReadonlyArray<{ key: string; resources: readonly string[] }> = [
  { key: 'planning', resources: ['project', 'process', 'task', 'milestone', 'assignment'] },
  { key: 'timesheet', resources: ['state', 'resource', 'worker'] },
  // Virtual resources: no ownership chain of their own (the only applicable
  // scope is "all"), so they share one section. The backend matrix is the
  // source of truth for WHICH of them exist — a resource missing here still
  // renders, in the trailing fallback section of the grid.
  {
    key: 'advanced',
    resources: ['user_catalog', 'user_admin', 'rbac_config', 'auto_create', 'state_admin', 'org_structure', 'audit', 'comment'],
  },
]

export const ADMIN_CAPABILITIES = [
  { key: 'accounts-view', resource: 'user_admin', actions: ['view'], title: 'accountsView', description: 'accountsView' },
  { key: 'accounts-manage', resource: 'user_admin', actions: ['create', 'update', 'delete'], title: 'accountsManage', description: 'accountsManage' },
  { key: 'roles', resource: 'rbac_config', actions: ['update'], title: 'roles', description: 'roles' },
  { key: 'template', resource: 'auto_create', actions: ['view', 'update'], title: 'template', description: 'template' },
  { key: 'day-types', resource: 'state', actions: ['create', 'update', 'delete'], title: 'dayTypes', description: 'dayTypes' },
  { key: 'structure', resource: 'org_structure', actions: ['view'], title: 'structure', description: 'structure' },
  { key: 'audit', resource: 'audit', actions: ['view'], title: 'audit', description: 'audit' },
] as const

/** Legacy partial grants stay visible until explicitly replaced. */
export function permissionActionGroups(resource: string, cells: readonly MatrixCellLike[]): Array<PresetActionGroup & { resource: string }> {
  if (resource === 'administration') {
    return ADMIN_CAPABILITIES.flatMap((capability) => {
      const actions = capability.actions.filter((action) => cells.some((cell) => cell.resource === capability.resource && cell.action === action))
      return actions.length ? [{ ...capability, actions }] : []
    })
  }
  const actions = gridActions(cells.filter((cell) => cell.resource === resource), ACTIONS)
    .filter((action) => (resource !== 'state' || action === 'view') && (resource !== 'worker' || action !== 'create'))
  return presetActionGroups(actions).map((group) => ({ ...group, resource,
    ...(resource === 'worker' && group.key === 'manage' ? { description: 'employeeCalendar' } : {}),
  }))
}

export function permissionBlocks(cells: readonly MatrixCellLike[]) {
  const administrative = new Set<string>(ADMIN_CAPABILITIES.filter((capability) => capability.resource !== 'state').map((capability) => capability.resource))
  const blocks = gridSections(cells.filter((cell) => cell.resource !== 'state_admin'), GROUPS)
    .flatMap((group) => group.resources.filter((resource) => !administrative.has(resource))
      .map((resource) => ({ resource, group: group.key })))
  if (permissionActionGroups('administration', cells).length) blocks.push({ resource: 'administration', group: 'administration' })
  return blocks.map((block, index) => ({ ...block, index }))
}

export const ACTIONS = ['view', 'create', 'update', 'delete'] as const

/** Resource → human-readable name (genitive case, for "View …" phrases). */
export function resourceLabel(resource: string): string {
  return t(`adminConfig.perm.resource.${resource}`)
}

/** Resource → human-readable name (nominative case, cards and headers). */
export function resourceTitle(resource: string): string {
  return t(`adminConfig.perm.resourceTitle.${resource}`)
}

/** Action code → human-readable name. */
export function actionTitle(action: string): string {
  return t(`adminConfig.perm.action.${action}`)
}

/** Scope option label in the resource context (falls back to the code itself). */
export function scopeOptionLabel(resource: string, scope: string): string {
  const opt = SCOPE_CATALOG[resource]?.find((o) => o.value === scope)
  return opt ? t(`adminConfig.perm.zone.${opt.label}`) : describeScopeExpr(scope)
}

export function scopeOptionDescription(resource: string, scope: string): string {
  const opt = SCOPE_CATALOG[resource]?.find((o) => o.value === scope)
  return opt?.description ? t(`adminConfig.perm.scopeHelp.${opt.description}`) : scopeOptionLabel(resource, scope)
}

/** Section title of a matrix group. */
export function groupTitle(key: string): string {
  return t(`adminConfig.perm.group.${key}`)
}

/** Human-readable scope label in the resource context. */
export function scopeLabel(resource: string, scope: string): string {
  const moves = scopeMoves(scope)
  return moves.length ? moves.map((move) => scopeOptionLabel(resource, move)).join(t('authz.scope.join')) : describeScopeExpr(scope)
}

/** Default grant zone per resource when enabling a capability with no preset
 *  zone (mirrors the backend applicability; canonical expressions). */
export const DEFAULT_GRANT_ZONE: Record<string, string> = {
  project: 'self',
  process: 'up1',
  task: 'up1',
  milestone: 'up1',
  assignment: 'up1',
  state: 'all',
  resource: 'self',
  worker: 'self',
  user_catalog: 'all',
  user_admin: 'all',
  rbac_config: 'all',
  auto_create: 'all',
  state_admin: 'all',
  org_structure: 'all',
  audit: 'all',
  comment: 'all',
}

/** Viewing a container always opens its contents; editing remains independent. */
export function viewParentResources(resource: string): string[] {
  if (resource === 'process') return ['project']
  if (resource === 'task' || resource === 'milestone') return ['project', 'process']
  if (resource === 'assignment') return ['project', 'process', 'task']
  return []
}

export function resourceDescription(resource: string): string {
  return ['state', 'resource', 'worker', 'user_catalog'].includes(resource)
    ? t(`adminConfig.perm.resourceHelp.${resource}`) : ''
}
