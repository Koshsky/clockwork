import { addDaysISO, cellEndDate, cellIndexForDate, cellStartDate, type PlanningUnit } from '../../src/domain/calendar'
import { resourceAvailableForDay, resourceCellUsage, resourceUsageWithPreview, indexResourcePeriods, type ResourceProcess, type TaskPreview } from '../../src/domain/resourceUsage'
import { applyRangeSplit } from '../../src/domain/timesheet'
import { updatePeriodAvailability } from '../../src/domain/periodAvailability'
import { addResourceAssignment, removeResourceAssignment, taskDateRollback } from '../../src/domain/planning'
import type { DtoResourceCalendar, DtoUserStateResponse } from '../../src/api'

const dates = ['2026-11-02', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23']
export const resourceScenarioIds = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export function resourceScenarioTrace(scenario: number, unit: PlanningUnit) {
  const resources = Array.from({ length: 12 }, (_, i) => ({ resource_id: i + 1, quantity: i + 2 }))
  const processes: ResourceProcess[] = [{ tasks: [
    { id: 7, start_date: '2026-11-09', end_date: '2026-11-22', resources: resources.slice(0, 2) },
    { id: 8, start_date: '2026-11-10', end_date: '2026-11-10', resources: [{ resource_id: 1, quantity: 7 }] },
  ] }]
  const task = processes[0]!.tasks![0]!
  let calendar: DtoResourceCalendar[] = resources.map((r) => ({ resource_id: r.resource_id, periods: [
    { start_date: '2026-10-01', end_date: '2026-11-09', capacity: 10, unavailable: 0, available: 10 },
    { start_date: '2026-11-10', end_date: '2026-11-10', capacity: 10, unavailable: r.resource_id === 1 ? 9 : 0, available: r.resource_id === 1 ? 1 : 10 },
    { start_date: '2026-11-11', end_date: '2026-12-31', capacity: 10, unavailable: 0, available: 10 },
  ] }))
  let preview: TaskPreview = { active: false, taskId: null, startDate: null, endDate: null }
  let periods: DtoUserStateResponse[] = []
  const trace: Record<string, {
    headers: Record<string, { used: number; available: number | null; isWeekend: boolean }[]>
    periods: DtoUserStateResponse[]
  }> = {}
  const record = (name: string) => {
    const index = indexResourcePeriods(calendar)
    const headers = Object.fromEntries(dates.map((date) => {
      const cell = cellIndexForDate('2026-11-02', unit, date)
      return [date, resources.map((resource) => resourceCellUsage(
        resource.resource_id, cellStartDate('2026-11-02', unit, cell), cellEndDate('2026-11-02', unit, cell),
        (id, day) => resourceUsageWithPreview(processes, id, day, preview),
        (id, day) => resourceAvailableForDay(index, id, day),
      ))]
    }))
    trace[name] = { headers, periods: periods.map((p) => ({ ...p })) }
  }
  const shifted = (delta: number) => ({
    start_date: addDaysISO('2026-11-09', delta), end_date: addDaysISO('2026-11-22', delta),
  })
  const showPreview = (patch: { start_date: string; end_date: string }) => {
    preview = { active: true, taskId: 7, startDate: patch.start_date, endDate: patch.end_date }
  }
  const stopPreview = () => { preview = { active: false, taskId: null, startDate: null, endDate: null } }
  const command = (name: string, patch: { start_date: string; end_date: string }) => {
    const previous = { start_date: task.start_date, end_date: task.end_date }
    Object.assign(task, patch)
    record(name + '-pending')
    // These are alternative server outcomes for the same proposal, not a rollback after acceptance.
    record(name + '-confirmed')
    const rollback = taskDateRollback(task, patch, previous)
    if (rollback) Object.assign(task, rollback)
    record(name + '-rejected')
  }
  const step = unit === 'week' ? 7 : 1
  if (scenario === 1) {
    task.resources = []
    record('before')
    let assignments: { id?: number; quantity?: number }[] = []
    for (const r of resources.slice(0, 2)) assignments = addResourceAssignment(assignments, { id: r.resource_id, quantity: r.quantity })
    task.resources = assignments.map((r) => ({ resource_id: r.id!, quantity: r.quantity! }))
    record('assigned')
  } else if (scenario === 2) {
    record('before')
    const assignments = task.resources!.map((r) => ({ id: r.resource_id, quantity: r.quantity }))
    task.resources = removeResourceAssignment(assignments, 1, 'resource').map((r) => ({ resource_id: r.id, quantity: r.quantity }))
    record('removed')
  } else if (scenario === 3) {
    record('before')
    showPreview(shifted(step)); record('right')
    showPreview(shifted(-step)); record('left')
    stopPreview(); record('cancelled')
  } else if (scenario === 4) {
    record('before')
    command('move', shifted(step))
  } else if (scenario === 5 || scenario === 6) {
    if (scenario === 6) task.resources = resources
    record('before')
    showPreview({ start_date: task.start_date, end_date: addDaysISO(task.end_date, step) }); record('right-preview')
    stopPreview()
    command('right', { start_date: task.start_date, end_date: addDaysISO(task.end_date, step) })
    showPreview({ start_date: addDaysISO(task.start_date, -step), end_date: task.end_date }); record('left-preview')
    stopPreview()
    command('left', { start_date: addDaysISO(task.start_date, -step), end_date: task.end_date })
  } else if (scenario === 7) {
    record('summary')
  } else if (scenario === 8 || scenario === 9) {
    const absent = [{ id: -1, state_id: 2, is_available: false, start_date: '2026-11-17', end_date: '2026-11-19' }]
    if (scenario === 9) {
      calendar = updatePeriodAvailability(calendar, 1, [], absent, '2026-11-17', '2026-11-19')
      periods = absent
    }
    record('before')
    const previous = periods
    const after = applyRangeSplit(previous, scenario === 8 ? 'put' : 'delete', '2026-11-17', '2026-11-19', undefined,
      scenario === 8 ? { id: -1, state_id: 2, is_available: false } : undefined)
    calendar = updatePeriodAvailability(calendar, 1, previous, after, '2026-11-17', '2026-11-19')
    periods = after
    record('pending'); record('confirmed')
    calendar = updatePeriodAvailability(calendar, 1, after, previous, '2026-11-17', '2026-11-19')
    periods = previous
    record('rejected')
  }
  return trace
}

export function allResourceScenarioTraces() {
  return Object.fromEntries((['day', 'week'] as const).map((unit) => [unit,
    Object.fromEntries(resourceScenarioIds.map((id) => [id, resourceScenarioTrace(id, unit)])),
  ]))
}
