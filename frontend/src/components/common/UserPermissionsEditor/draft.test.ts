import { describe, expect, it } from 'vitest'
import { applyPermissionGroup, overrideSignature } from './draft'
import type { PermissionCell, PermissionOverride } from './types'

const actions = ['create', 'update', 'delete']
const baseline: PermissionCell[] = actions.map((action) => ({ resource: 'task', action, scope: 'up1' }))

describe('individual permission draft', () => {
  it('does not mark denied scope normalization or rule order as an edit', () => {
    const saved: PermissionOverride[] = [
      { resource: 'task', action: 'view', scope: 'all', granted: false },
      { resource: 'resource', action: 'view', scope: 'own', granted: true },
    ]
    expect(overrideSignature(saved)).toBe(overrideSignature([
      { resource: 'resource', action: 'view', scope: 'self', granted: true },
      { resource: 'task', action: 'view', granted: false },
    ]))
  })

  it('applies management to three concrete actions and keeps unrelated overrides', () => {
    const view = { resource: 'task', action: 'view', granted: false }
    const resource = { resource: 'resource', action: 'update', scope: 'self', granted: true }
    const existing: PermissionOverride[] = [view, resource, { resource: 'task', action: 'update', scope: 'sib', granted: true }]
    const result = applyPermissionGroup(existing, baseline, 'task', actions, 'project_owner')
    expect(result.filter((rule) => actions.includes(rule.action) && rule.resource === 'task')).toEqual(
      expect.arrayContaining(actions.map((action) => ({ resource: 'task', action, scope: 'project_owner', granted: true }))),
    )
    expect(result).toContainEqual(view)
    expect(result).toContainEqual(resource)
    expect(existing[2].scope).toBe('sib')
  })

  it('returning to the role removes only matching group overrides, including legacy equivalent scopes', () => {
    const outside = { resource: 'resource', action: 'view', scope: 'self', granted: true }
    const overrides = actions.map((action) => ({ resource: 'task', action, scope: 'all', granted: true })).concat(outside)
    expect(applyPermissionGroup(overrides, baseline, 'task', actions, 'process_owner')).toEqual([outside])
  })

  it('preserves separate baseline rules rather than copying one action to its siblings', () => {
    const mixed = baseline.map((cell) => ({ ...cell, scope: cell.action === 'update' ? 'all' : 'up1' }))
    const result = applyPermissionGroup([], mixed, 'task', actions, 'process_owner')
    expect(result).toEqual([{ resource: 'task', action: 'update', scope: 'process_owner', granted: true }])
  })

  it('denies all three management actions while retaining view', () => {
    const view = { resource: 'task', action: 'view', scope: 'all', granted: true }
    const result = applyPermissionGroup([view], baseline, 'task', actions, 'none')
    expect(result).toEqual([view, ...actions.map((action) => ({ resource: 'task', action, scope: '', granted: false }))])
  })

  it('no access in an already empty baseline does not invent extra grants or overrides', () => {
    expect(applyPermissionGroup([], [], 'task', actions, 'none')).toEqual([])
  })

  it('keeps priority independent from project management', () => {
    const priority = { resource: 'project', action: 'prioritize', scope: 'all', granted: true }
    const result = applyPermissionGroup([priority], [], 'project', actions, 'self')
    expect(result).toContainEqual(priority)
    expect(result.filter((rule) => actions.includes(rule.action))).toHaveLength(3)
  })
})
