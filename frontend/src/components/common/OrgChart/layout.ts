import { hierarchy, tree as tidyTree } from 'd3-hierarchy'
import type { DtoAdminUserResponse } from '@/api'
import { compareByName } from '../../../utils/byName'

export interface OrgNode {
  id: number
  user: DtoAdminUserResponse
  parent: number | null
  children: number[]
  descendants: number
  depth: number
  issue: boolean
}
export interface OrgForest {
  nodes: Map<number, OrgNode>
  roots: number[]
  order: OrgNode[]
  issues: number
}
export interface ManagerTeams {
  roots: number[]
  children: Map<number, number[]>
  members: Map<number, DtoAdminUserResponse[]>
  unassigned: DtoAdminUserResponse[]
}
export interface ChartNode { id: number; x: number; y: number; height: number }
export interface ChartLayout {
  nodes: ChartNode[]
  byId: Map<number, ChartNode>
  groups: Array<{ parent: ChartNode; children: ChartNode[] }>
  width: number
  height: number
}
export interface ChartViewport { left: number; top: number; width: number; height: number }
export const CARD_WIDTH = 280
export const CARD_HEADER_HEIGHT = 84
export const TEAM_PREVIEW_SIZE = 2
export const TEAM_PAGE_SIZE = 5
const COLUMN_GAP = 32
const LEVEL_GAP = 60
const PADDING = 32

// Broken edges are removed only in the view model; server relationships remain untouched.
export function buildOrgForest(employees: DtoAdminUserResponse[]): OrgForest {
  const nodes = new Map<number, OrgNode>()
  let invalid = 0
  for (const user of employees) {
    if (user.id == null || !Number.isSafeInteger(user.id) || nodes.has(user.id)) { invalid++; continue }
    nodes.set(user.id, { id: user.id, user, parent: user.manager_id ?? null, children: [], descendants: 0, depth: 0, issue: false })
  }
  for (const node of nodes.values()) {
    if (node.parent != null && (!nodes.has(node.parent) || node.parent === node.id)) {
      node.issue = true
      node.parent = null
    }
  }
  const finished = new Set<number>()
  for (const start of nodes.keys()) {
    const path: number[] = []
    const positions = new Map<number, number>()
    let id: number | null = start
    while (id != null && !finished.has(id)) {
      const cycleAt = positions.get(id)
      if (cycleAt != null) {
        const cycle = path.slice(cycleAt)
        let root = cycle[0]!
        for (const member of cycle) {
          nodes.get(member)!.issue = true
          root = Math.min(root, member)
        }
        nodes.get(root)!.parent = null
        break
      }
      positions.set(id, path.length)
      path.push(id)
      id = nodes.get(id)!.parent
    }
    for (const member of path) finished.add(member)
  }
  const roots: number[] = []
  for (const node of nodes.values()) {
    if (node.parent == null) roots.push(node.id)
    else nodes.get(node.parent)!.children.push(node.id)
  }
  const sort = (ids: number[]) => ids.sort((a, b) => compareByName(nodes.get(a)!.user, nodes.get(b)!.user) || a - b)
  sort(roots)
  for (const node of nodes.values()) sort(node.children)
  const order: OrgNode[] = []
  const stack = roots.slice().reverse()
  while (stack.length) {
    const node = nodes.get(stack.pop()!)!
    order.push(node)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = nodes.get(node.children[i]!)!
      child.depth = node.depth + 1
      stack.push(child.id)
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!
    if (node.parent != null) nodes.get(node.parent)!.descendants += 1 + node.descendants
  }
  return { nodes, roots, order, issues: invalid + order.filter((node) => node.issue).length }
}

// Only managers receive graph nodes; every other employee belongs to exactly one list.
export function buildManagerTeams(forest: OrgForest): ManagerTeams {
  const children = new Map<number, number[]>()
  const members = new Map<number, DtoAdminUserResponse[]>()
  for (const node of forest.order) {
    if (!node.children.length) continue
    const managers: number[] = []
    const staff: DtoAdminUserResponse[] = []
    for (const id of node.children) {
      const child = forest.nodes.get(id)!
      if (child.children.length) managers.push(id)
      else staff.push(child.user)
    }
    children.set(node.id, managers)
    members.set(node.id, staff)
  }
  return {
    roots: forest.roots.filter((id) => children.has(id)), children, members,
    unassigned: forest.roots.filter((id) => !children.has(id)).map((id) => forest.nodes.get(id)!.user),
  }
}

export function initialExpanded(forest: OrgForest): Set<number> {
  return new Set(forest.roots.filter((id) => forest.nodes.get(id)!.children.some((child) => forest.nodes.get(child)!.children.length)))
}

export function managerCardHeight(staffCount: number, managerCount: number, page = -1): number {
  const expandedList = page >= 0 && staffCount > TEAM_PREVIEW_SIZE
  const rows = expandedList ? Math.min(TEAM_PAGE_SIZE, staffCount) : Math.min(TEAM_PREVIEW_SIZE, staffCount)
  const staffHeight = staffCount ? 28 + rows * 32 + (expandedList ? 64 : staffCount > TEAM_PREVIEW_SIZE ? 32 : 0) : 0
  return CARD_HEADER_HEIGHT + staffHeight + (managerCount ? 40 : 0) + 4
}

export function layoutOrgChart(forest: OrgForest, expanded: ReadonlySet<number>, pages: Readonly<Record<string, number>> = {}, teams = buildManagerTeams(forest)): ChartLayout {
  // A synthetic root permits multiple independent managers without inventing an employee.
  const virtual = hierarchy<number | null>(null, (id) => id == null ? teams.roots : expanded.has(id) ? teams.children.get(id) : undefined)
  const positioned = tidyTree<number | null>().nodeSize([CARD_WIDTH + COLUMN_GAP, 1])(virtual)
  const actual = positioned.descendants().filter((node) => node.data != null)
  const heights = new Map<number, number>()
  const rowHeights: number[] = []
  let left = 0
  let right = 0
  for (const node of actual) {
    const id = node.data!
    const height = managerCardHeight(teams.members.get(id)?.length ?? 0, teams.children.get(id)?.length ?? 0, pages[id] ?? -1)
    heights.set(id, height)
    rowHeights[node.depth - 1] = Math.max(rowHeights[node.depth - 1] ?? 0, height)
    left = Math.min(left, node.x)
    right = Math.max(right, node.x)
  }
  const rowTops: number[] = []
  let nextTop = PADDING
  for (const height of rowHeights) { rowTops.push(nextTop); nextTop += height + LEVEL_GAP }
  const nodes = actual.map((node) => ({ id: node.data!, x: node.x - left + PADDING, y: rowTops[node.depth - 1]!, height: heights.get(node.data!)! }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const groups = nodes.filter((node) => expanded.has(node.id)).map((node) => ({
    parent: node,
    children: (teams.children.get(node.id) ?? []).map((id) => byId.get(id)).filter((child): child is ChartNode => child != null),
  })).filter((group) => group.children.length)
  return { nodes, byId, groups, width: right - left + CARD_WIDTH + PADDING * 2, height: Math.max(CARD_HEADER_HEIGHT + PADDING * 2, nextTop - LEVEL_GAP + PADDING) }
}

export function visibleChartNodes(layout: ChartLayout, view: ChartViewport): ChartNode[] {
  return layout.nodes.filter((node) => node.x + CARD_WIDTH >= view.left - CARD_WIDTH && node.x <= view.left + view.width + CARD_WIDTH && node.y + node.height >= view.top - CARD_WIDTH && node.y <= view.top + view.height + CARD_WIDTH)
}

export function visibleChartLinks(layout: ChartLayout, view: ChartViewport): string[] {
  const paths: string[] = []
  for (const { parent, children } of layout.groups) {
    const start = parent.y + parent.height
    const end = children[0]!.y
    if (start > view.top + view.height || end < view.top) continue
    const xs = children.map((child) => child.x + CARD_WIDTH / 2)
    const from = xs[0]!
    const to = xs[xs.length - 1]!
    const x = parent.x + CARD_WIDTH / 2
    const middle = end - LEVEL_GAP / 2
    let path = `M${x},${start}V${middle}M${from},${middle}H${to}`
    for (const childX of xs) {
      if (childX >= view.left && childX <= view.left + view.width) path += `M${childX},${middle}V${end}`
    }
    if (Math.max(x, to) >= view.left && Math.min(x, from) <= view.left + view.width) paths.push(path)
  }
  return paths
}
