import { describe, expect, it } from 'vitest'
import { buildOrgForest, buildManagerTeams, CARD_WIDTH, initialExpanded, layoutOrgChart, managerCardHeight, visibleChartLinks, visibleChartNodes } from './layout'
import type { DtoAdminUserResponse } from '@/api'

const user = (id: number, manager_id?: number): DtoAdminUserResponse => ({ id, manager_id, name: `Employee ${String(id).padStart(5, '0')}`, position: 'Engineer' })

describe('organizational forest', () => {
  it('keeps multiple roots, orphaned employees and cycles visible without mutating input', () => {
    const employees = [user(1), user(2, 1), user(3, 2), user(4, 999), user(5, 6), user(6, 5), user(7, 7), user(8)]
    const before = JSON.stringify(employees)
    const forest = buildOrgForest(employees)
    expect(forest.order).toHaveLength(8)
    expect(new Set(forest.order.map((node) => node.id)).size).toBe(8)
    expect(forest.roots).toEqual([1, 4, 5, 7, 8])
    expect(forest.nodes.get(1)?.descendants).toBe(2)
    expect(forest.nodes.get(2)?.descendants).toBe(1)
    expect(forest.nodes.get(5)?.descendants).toBe(1)
    expect(forest.issues).toBe(4)
    expect(JSON.stringify(employees)).toBe(before)
  })
  it('rejects duplicate/invalid identities without duplicating a card', () => {
    const forest = buildOrgForest([user(1), user(1), { name: 'Missing ID' }, { id: NaN }])
    expect(forest.order).toHaveLength(1)
    expect(forest.issues).toBe(3)
  })
  it('handles empty data', () => {
    const layout = layoutOrgChart(buildOrgForest([]), new Set())
    expect(layout.nodes).toEqual([])
    expect(layout.groups).toEqual([])
    expect(layout.width).toBeGreaterThan(0)
  })
  it('retains the original full descendant count when branches collapse', () => {
    const forest = buildOrgForest([user(1), user(2, 1), user(3, 2), user(4, 2)])
    const layout = layoutOrgChart(forest, new Set([1]))
    expect(layout.nodes.map((node) => node.id)).toEqual([1, 2])
    expect(forest.nodes.get(1)?.descendants).toBe(3)
    expect(forest.nodes.get(2)?.children).toHaveLength(2)
  })
})

describe('large chart layout', () => {
  for (const shape of ['wide', 'deep', 'balanced'] as const) {
    it(`lays out 10,000 ${shape} employees without recursion overflow or unbounded viewport DOM`, () => {
      const employees = Array.from({ length: 10000 }, (_, i) => user(i + 1, i === 0 ? undefined : shape === 'wide' ? 1 : shape === 'deep' ? i : Math.floor((i - 1) / 4) + 1))
      if (shape === 'deep') employees.reverse()
      const start = performance.now()
      const forest = buildOrgForest(employees)
      const layout = layoutOrgChart(forest, new Set(forest.order.map((node) => node.id)))
      const elapsed = performance.now() - start
      expect(forest.order).toHaveLength(10000)
      expect(forest.nodes.get(1)?.descendants).toBe(9999)
      expect(layout.nodes).toHaveLength(forest.order.filter((node) => node.children.length).length)
      expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && node.x >= 0 && node.y >= 0 && node.x + CARD_WIDTH <= layout.width && node.y + node.height <= layout.height)).toBe(true)
      const root = layout.byId.get(1)!
      const view = { left: Math.max(0, root.x - 400), top: 0, width: 900, height: 520 }
      expect(visibleChartNodes(layout, view).length).toBeLessThan(50)
      expect(visibleChartLinks(layout, view).length).toBeLessThan(50)
      expect(initialExpanded(forest).size).toBeLessThan(60)
      // A generous ceiling catches accidental quadratic walks without asserting benchmark precision.
      expect(elapsed).toBeLessThan(10000)
      console.info(`[org-layout] ${shape}: ${employees.length} employees, ${elapsed.toFixed(1)} ms`)
    })
  }
  it('separates sibling cards and preserves parent/child levels', () => {
    const forest = buildOrgForest([user(1), user(2, 1), user(3, 1), user(4, 2), user(5)])
    const layout = layoutOrgChart(forest, new Set(forest.nodes.keys()))
    for (const node of forest.order) {
      const position = layout.byId.get(node.id)
      if (!position) continue
      if (node.parent != null) {
        const parent = layout.byId.get(node.parent)!
        expect(position.y).toBeGreaterThan(parent.y + parent.height)
      }
      for (const other of layout.nodes) {
        if (node.id !== other.id && position.y === other.y) expect(Math.abs(position.x - other.x)).toBeGreaterThanOrEqual(CARD_WIDTH)
      }
    }
  })
})


describe('manager cards and employee lists', () => {
  it('represents every employee exactly once, independently of title or preset', () => {
    const employees = [user(1), user(2, 1), { ...user(3, 1), position: 'Director', preset: 'admin' }, user(4, 2), user(5), user(6, 999)]
    const forest = buildOrgForest(employees)
    const teams = buildManagerTeams(forest)
    expect(teams.roots).toEqual([1])
    expect([...teams.children.keys()]).toEqual([1, 2])
    expect(teams.children.get(1)).toEqual([2])
    expect(teams.members.get(1)?.map((item) => item.id)).toEqual([3])
    expect(teams.members.get(2)?.map((item) => item.id)).toEqual([4])
    expect(teams.unassigned.map((item) => item.id)).toEqual([5, 6])
    const represented = [...teams.children.keys(), ...[...teams.members.values()].flat().map((item) => item.id), ...teams.unassigned.map((item) => item.id)]
    expect(represented.sort()).toEqual([1, 2, 3, 4, 5, 6])
    expect(new Set(represented).size).toBe(employees.length)
  })
  it('initially shows exactly two manager levels and expands only the chosen branch', () => {
    const forest = buildOrgForest([user(1), user(2, 1), user(3, 2), user(4, 3), user(5, 4), user(6, 1), user(7, 6), user(8, 7)])
    const expanded = initialExpanded(forest)
    expect([...expanded]).toEqual([1])
    expect(layoutOrgChart(forest, expanded).nodes.map((node) => node.id)).toEqual([1, 2, 6])
    expanded.add(2)
    expect(layoutOrgChart(forest, expanded).nodes.map((node) => node.id)).toEqual([1, 2, 6, 3])
    expect(layoutOrgChart(forest, expanded).byId.has(7)).toBe(false)
  })
  it('moves lower levels below expanded inline lists and keeps pagination geometry stable', () => {
    const employees = [user(1), user(2, 1), user(3, 1), user(4, 2), user(500, 4), ...Array.from({ length: 25 }, (_, i) => user(i + 100, 2)), ...Array.from({ length: 50 }, (_, i) => user(i + 300, 3))]
    const forest = buildOrgForest(employees)
    const expanded = new Set([1, 2])
    const compact = layoutOrgChart(forest, expanded)
    const open = layoutOrgChart(forest, expanded, { 2: 0 })
    expect(open.byId.get(2)!.height).toBeGreaterThan(compact.byId.get(2)!.height)
    expect(open.byId.get(4)!.y).toBeGreaterThan(compact.byId.get(4)!.y)
    expect(open.byId.get(4)!.y).toBeGreaterThan(open.byId.get(2)!.y + open.byId.get(2)!.height)
    expect(open.byId.get(3)!.height).toBe(compact.byId.get(3)!.height)
    expect(managerCardHeight(26, 1, 0)).toBe(managerCardHeight(26, 1, 5))
    expect(managerCardHeight(50, 1)).toBe(managerCardHeight(25, 1))
  })
  it('keeps a company without managers available in the unassigned list', () => {
    const forest = buildOrgForest([user(1), user(2), user(3, 999)])
    const teams = buildManagerTeams(forest)
    expect(layoutOrgChart(forest, initialExpanded(forest)).nodes).toEqual([])
    expect(teams.unassigned).toHaveLength(3)
    expect(forest.issues).toBe(1)
  })
})
