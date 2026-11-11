import { canonicalScope } from '@/rbacScope'
import { NO_ACCESS } from '@/utils/rbacGrid'
import { simpleScope } from './labels'
import type { PermissionCell, PermissionOverride } from './types'

export function overrideSignature(overrides: readonly PermissionOverride[]): string {
  return JSON.stringify(overrides.map((rule) => ({
    resource: rule.resource,
    action: rule.action,
    granted: rule.granted,
    scope: rule.granted ? canonicalScope(rule.scope ?? '') : '',
  })).sort((a, b) => `${a.resource}/${a.action}`.localeCompare(`${b.resource}/${b.action}`)))
}

/** A common condition changes only the concrete actions that belong to the group. */
export function applyPermissionGroup(
  overrides: readonly PermissionOverride[],
  baseline: readonly PermissionCell[],
  resource: string,
  actions: readonly string[],
  scope: string,
): PermissionOverride[] {
  const next = new Map(overrides.map((rule) => [`${rule.resource}/${rule.action}`, { ...rule }]))
  for (const action of actions) {
    const key = `${resource}/${action}`
    const preset = baseline.find((cell) => cell.resource === resource && cell.action === action)?.scope ?? ''
    const presetScope = simpleScope(resource, preset) || NO_ACCESS
    if (canonicalScope(scope) === canonicalScope(presetScope)) {
      next.delete(key)
    } else if (scope === NO_ACCESS || !scope) {
      next.set(key, { resource, action, scope: '', granted: false })
    } else {
      next.set(key, { resource, action, scope, granted: true })
    }
  }
  return [...next.values()]
}
