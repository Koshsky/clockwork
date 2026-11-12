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
  const dayT = day.getTime()
  const inNew = dayT >= toDate(preview.startDate).getTime() && dayT <= toDate(preview.endDate).getTime()
  const inOld = dayT >= toDate(task.start_date).getTime() && dayT <= toDate(task.end_date).getTime()
  if (inNew === inOld) return used
  return inNew ? used + assignment.quantity : used - assignment.quantity
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
