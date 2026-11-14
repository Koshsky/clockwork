import { fmtDate, toDate } from './calendar'

export interface ResourcePeriod {
  start_date?: string
  end_date?: string
  available?: number
}

export interface ResourceTask {
  id: number
  start_date: string
  end_date: string
  resources?: { resource_id: number; quantity: number }[]
}

export interface ResourceProcess {
  tasks?: ResourceTask[]
}

export interface TaskPreview {
  active: boolean
  taskId: number | null
  startDate: string | null
  endDate: string | null
}

export function indexResourcePeriods(calendar: { resource_id?: number; periods?: ResourcePeriod[] }[]): Map<number, ResourcePeriod[]> {
  const map = new Map<number, ResourcePeriod[]>()
  for (const rc of calendar) {
    if (rc.resource_id != null && Array.isArray(rc.periods)) map.set(rc.resource_id, rc.periods)
  }
  return map
}

export function resourceAvailableForDay(periodsByResource: ReadonlyMap<number, ResourcePeriod[]>, resourceId: number, day: Date): number | null {
  const periods = periodsByResource.get(resourceId)
  if (!periods || !periods.length) return null
  const iso = fmtDate(day)
  for (const p of periods) {
    if (p.start_date != null && p.end_date != null && iso >= p.start_date && iso <= p.end_date) return p.available ?? 0
  }
  return null
}

export function resourceUsageForDay(processes: ResourceProcess[], resourceId: number, day: Date): number {
  let used = 0
  for (const proc of processes) {
    for (const task of proc.tasks ?? []) {
      const d = day.getTime()
      if (d < toDate(task.start_date).getTime() || d > toDate(task.end_date).getTime()) continue
      const assignment = (task.resources ?? []).find((r) => r.resource_id === resourceId)
      if (assignment) used += assignment.quantity
    }
  }
  return used
}

interface ResourceDemandRange {
  start: number
  end: number
  quantity: number
}

interface IndexedResourceTask {
  start: number
  end: number
  quantities: ReadonlyMap<number, number>
}

export interface ResourceDemandIndex {
  ranges: ReadonlyMap<number, readonly ResourceDemandRange[]>
  tasks: ReadonlyMap<number, IndexedResourceTask>
}

/** A weekly header otherwise reparses every task's dates for every resource and day. */
export function indexResourceDemand(processes: ResourceProcess[]): ResourceDemandIndex {
  const ranges = new Map<number, ResourceDemandRange[]>()
  const tasks = new Map<number, IndexedResourceTask>()
  for (const process of processes) {
    for (const task of process.tasks ?? []) {
      const start = toDate(task.start_date).getTime()
      const end = toDate(task.end_date).getTime()
      const quantities = new Map<number, number>()
      for (const assignment of task.resources ?? []) {
        // The reference lookup uses find: duplicate assignments keep their first quantity.
        if (Number.isNaN(assignment.resource_id) || quantities.has(assignment.resource_id)) continue
        quantities.set(assignment.resource_id, assignment.quantity)
        const resource = ranges.get(assignment.resource_id) ?? []
        resource.push({ start, end, quantity: assignment.quantity })
        ranges.set(assignment.resource_id, resource)
      }
      // Preview also uses the first matching task when a malformed payload repeats an id.
      if (!tasks.has(task.id)) tasks.set(task.id, { start, end, quantities })
    }
  }
  return { ranges, tasks }
}

function previewUsage(used: number, day: Date, preview: TaskPreview, quantity: number, start: number, end: number): number {
  const dayT = day.getTime()
  const inNew = dayT >= toDate(preview.startDate!).getTime() && dayT <= toDate(preview.endDate!).getTime()
  const inOld = dayT >= start && dayT <= end
  if (inNew === inOld) return used
  return inNew ? used + quantity : used - quantity
}

export function indexedResourceUsage(index: ResourceDemandIndex, resourceId: number, day: Date, preview: TaskPreview): number {
  let used = 0
  const dayT = day.getTime()
  for (const range of index.ranges.get(resourceId) ?? []) {
    if (dayT < range.start || dayT > range.end) continue
    used += range.quantity
  }
  if (!preview.active || preview.taskId == null || preview.startDate == null || preview.endDate == null || Number.isNaN(preview.taskId)) return used
  const task = index.tasks.get(preview.taskId)
  if (!task?.quantities.has(resourceId)) return used
  const quantity = task.quantities.get(resourceId)!
  if (quantity === 0) return used
  return previewUsage(used, day, preview, quantity, task.start, task.end)
}

/** The held gesture changes demand without changing the saved task or sending a command. */
export function resourceUsageWithPreview(processes: ResourceProcess[], resourceId: number, day: Date, preview: TaskPreview): number {
  const used = resourceUsageForDay(processes, resourceId, day)
  if (!preview.active || preview.taskId == null || preview.startDate == null || preview.endDate == null) return used
  let task: ResourceTask | undefined
  for (const process of processes) {
    task = (process.tasks ?? []).find((t) => t.id === preview.taskId)
    if (task) break
  }
  if (!task) return used
  const assignment = (task.resources ?? []).find((r) => r.resource_id === resourceId)
  if (!assignment || assignment.quantity === 0) return used
  return previewUsage(used, day, preview, assignment.quantity, toDate(task.start_date).getTime(), toDate(task.end_date).getTime())
}

/** The peak and minimum may fall on different days; Monday alone is not representative. */
export function resourceCellUsage(
  resourceId: number, start: Date, end: Date,
  usage: (resourceId: number, day: Date) => number,
  available: (resourceId: number, day: Date) => number | null,
): { used: number; available: number | null; isWeekend: boolean } {
  let peak = 0
  let minAvail: number | null = null
  let hasUnknown = false
  let weekend = true
  const cur = new Date(start)
  while (cur <= end) {
    const wd = cur.getDay() === 0 || cur.getDay() === 6
    if (!wd) weekend = false
    peak = Math.max(peak, usage(resourceId, cur))
    const avail = available(resourceId, cur)
    if (avail == null) hasUnknown = true
    else if (minAvail == null || avail < minAvail) minAvail = avail
    cur.setDate(cur.getDate() + 1)
  }
  return { used: peak, available: hasUnknown ? null : minAvail, isWeekend: weekend }
}

export function resourceAbsencesInRange<T extends { start_date?: string; end_date?: string }>(list: T[], start: Date, end: Date): T[] {
  const startT = start.getTime()
  const endT = end.getTime()
  return list.filter((absence) => {
    const s = absence.start_date ? new Date(`${absence.start_date}T00:00:00`).getTime() : -Infinity
    const e = absence.end_date ? new Date(`${absence.end_date}T00:00:00`).getTime() : Infinity
    return s <= endT && e >= startT
  })
}

export function assignmentOwnersCompatible(processOwner: number | null | undefined, resourceOwner: number | null | undefined): boolean {
  return processOwner == null || resourceOwner == null || processOwner === resourceOwner
}

export function assignmentAllowed(context: {
  processOwner?: number | null; resourceOwner?: number | null
  taskOwner?: number | null; userId?: number | null; all: boolean
}): boolean {
  if (!assignmentOwnersCompatible(context.processOwner, context.resourceOwner)) return false
  return context.all || context.resourceOwner == null || (context.resourceOwner === context.userId && context.taskOwner === context.userId)
}
