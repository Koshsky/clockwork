import { describe, expect, it } from 'vitest'
import { resourcePageAccessible, resourceHeaderRows, resourceHeaderOwners, resourceBadgeRows } from './resourceAccess'
describe('resource page and header access', () => {
  it.each(['view', 'create', 'update', 'delete'])('shows navigation for %s alone', (allowed) => {
    expect(resourcePageAccessible((resource, action) => resource === 'resource' && action === allowed)).toBe(true)
  })
  it('hides the page only when all four actions are denied', () => {
    expect(resourcePageAccessible(() => false)).toBe(false)
  })
  it('shows exactly the selected owner resources, including zero assignments', () => {
    const own = { owner_id: 7, id: 1 }
    expect(resourceHeaderRows<{ owner_id?: number; id: number }>([own, { owner_id: 8, id: 2 }, { id: 3 }], 7)).toEqual([own])
    expect(resourceHeaderRows([own], null)).toEqual([])
  })
})


describe('resource-header owner options', () => {
  it('offers each resource owner once, preserving user catalogue order', () => {
    expect(resourceHeaderOwners([{ id: 7 }, { id: 8 }, { id: 9 }], [{ owner_id: 8 }, { owner_id: 8 }, { owner_id: 7 }])).toEqual([{ id: 7 }, { id: 8 }])
  })
  it('offers no users when no resources exist', () => {
    expect(resourceHeaderOwners([{ id: 7 }], [])).toEqual([])
  })
  it('does not treat missing owner or user IDs as ownership', () => {
    expect(resourceHeaderOwners([{}, { id: 7 }], [{}])).toEqual([])
  })
  it('reflects resource ownership transfers without changing the user catalogue', () => {
    const users = [{ id: 7 }, { id: 8 }]
    expect(resourceHeaderOwners(users, [{ owner_id: 7 }])).toEqual([{ id: 7 }])
    expect(resourceHeaderOwners(users, [{ owner_id: 8 }])).toEqual([{ id: 8 }])
    expect(users).toEqual([{ id: 7 }, { id: 8 }])
  })
})


describe('resource badges use the header selection', () => {
  const assignments = [
    { resource_id: 10, quantity: 2 },
    { resource_id: 20, quantity: 5 },
  ]
  it('preserves all assignments when no display filter is active', () => {
    expect(resourceBadgeRows(assignments)).toBe(assignments)
  })
  it('shows only the resources belonging to the selected owner', () => {
    const resources = [{ id: 10, owner_id: 1 }, { id: 20, owner_id: 2 }]
    const ids = new Set(resourceHeaderRows(resources, 2).map(row => row.id))
    expect(resourceBadgeRows(assignments, ids)).toEqual([assignments[1]])
    expect(assignments).toHaveLength(2)
    expect(assignments.map(row => row.quantity)).toEqual([2, 5])
  })
  it('hides unmatched badges even if the selected owner has no assigned resources', () => {
    expect(resourceBadgeRows(assignments, new Set([30]))).toEqual([])
    expect(resourceBadgeRows(assignments, new Set())).toEqual([])
  })
  it('supports empty tasks without synthesizing resource assignments', () => {
    expect(resourceBadgeRows([], new Set([10]))).toEqual([])
  })
})
