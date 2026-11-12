import { describe, expect, it, vi } from 'vitest'
import { fmtDate, cellStartDate, cellEndDate, cellIndexForDate, isoWeek, toDate } from './calendar'
import { indexResourcePeriods, resourceAvailableForDay, resourceAbsencesInRange, resourceCellUsage, resourceUsageForDay, resourceUsageWithPreview } from './resourceUsage'

describe('resource demand and availability edge cases', () => {
  it('sums overlapping tasks from several processes without changing the inputs', () => {
    const processes = [{ tasks: [{ id: 1, start_date: '2026-11-09', end_date: '2026-11-09', resources: [{ resource_id: 1, quantity: 2 }] }] },
      { tasks: [{ id: 2, start_date: '2026-11-09', end_date: '2026-11-10', resources: [{ resource_id: 1, quantity: 4 }, { resource_id: 2, quantity: 3 }] }] }]
    const copy = structuredClone(processes)
    expect(resourceUsageForDay(processes, 1, toDate('2026-11-09'))).toBe(6)
    expect(resourceUsageForDay(processes, 2, toDate('2026-11-09'))).toBe(3)
    expect(resourceUsageForDay(processes, 1, toDate('2026-11-10'))).toBe(4)
    expect(resourceUsageForDay(processes, 1, toDate('2026-11-11'))).toBe(0)
    expect(processes).toEqual(copy)
  })
  it.each([
    { active: false, taskId: 1, startDate: '2026-11-10', endDate: '2026-11-10' },
    { active: true, taskId: null, startDate: '2026-11-10', endDate: '2026-11-10' },
    { active: true, taskId: 1, startDate: null, endDate: '2026-11-10' },
    { active: true, taskId: 99, startDate: '2026-11-10', endDate: '2026-11-10' },
  ])('ignores inactive, incomplete or missing-task previews (%j)', (preview) => {
    const processes = [{ tasks: [{ id: 1, start_date: '2026-11-09', end_date: '2026-11-09', resources: [{ resource_id: 1, quantity: 2 }] }] }]
    expect(resourceUsageWithPreview(processes, 1, toDate('2026-11-10'), preview)).toBe(0)
    expect(processes[0]!.tasks[0]!.start_date).toBe('2026-11-09')
  })
  it('marks weekly availability unknown if even one day has no coverage', () => {
    const result = resourceCellUsage(1, toDate('2026-11-09'), toDate('2026-11-15'),
      (_, day) => day.getDate() === 10 ? 9 : 2,
      (_, day) => day.getDate() === 12 ? null : 10)
    expect(result).toEqual({ used: 9, available: null, isWeekend: false })
  })
  it('distinguishes zero availability, no periods, missing bounds and an unknown resource', () => {
    const periods = indexResourcePeriods([{ resource_id: 1, periods: [{ start_date: '2026-11-09', end_date: '2026-11-09' }] },
      { resource_id: 2, periods: [] }, { resource_id: 3, periods: [{ available: 5 }] }])
    expect(resourceAvailableForDay(periods, 1, toDate('2026-11-09'))).toBe(0)
    for (const id of [2, 3, 99]) expect(resourceAvailableForDay(periods, id, toDate('2026-11-09'))).toBeNull()
  })
  it('marks a cell as weekend only if all its dates are weekends', () => {
    const cell = (start: string, end: string) => resourceCellUsage(1, toDate(start), toDate(end), () => 0, () => 0)
    expect(cell('2026-11-14', '2026-11-15').isWeekend).toBe(true)
    expect(cell('2026-11-13', '2026-11-15').isWeekend).toBe(false)
  })
  it('keeps overlapping absence rows and inclusive or open-ended bounds', () => {
    const list = [{ start_date: '2026-11-01', end_date: '2026-11-08' }, { start_date: '2026-11-09', end_date: '2026-11-09' },
      { start_date: '2026-11-15' }, { end_date: '2026-11-10' }, { start_date: '2026-11-16', end_date: '2026-11-20' }]
    expect(resourceAbsencesInRange(list, toDate('2026-11-09'), toDate('2026-11-15'))).toEqual([list[1], list[2], list[3]])
    expect(list).toHaveLength(5)
  })
  it('calculates a large loaded structure without truncating resource usage', () => {
    const processes = Array.from({ length: 100 }, (_, process) => ({ tasks: Array.from({ length: 50 }, (_, task) => ({
      id: process * 50 + task, start_date: '2026-11-09', end_date: '2026-11-15', resources: [{ resource_id: 1, quantity: 2 }],
    })) }))
    expect(resourceUsageForDay(processes, 1, toDate('2026-11-10'))).toBe(10000)
    expect(resourceUsageWithPreview(processes, 1, toDate('2026-11-10'), { active: true, taskId: 4999, startDate: '2026-11-16', endDate: '2026-11-22' })).toBe(9998)
  })
})

describe('ISO calendar across timezone and year boundaries', () => {
  it.each(['UTC', 'Europe/Moscow', 'America/New_York'])('preserves civil weeks in %s', (zone) => {
    vi.stubEnv('TZ', zone)
    try {
      for (const [origin, date, monday, sunday] of [
        ['2026-03-04', '2026-03-08', '2026-03-02', '2026-03-08'],
        ['2026-10-29', '2026-11-01', '2026-10-26', '2026-11-01'],
        ['2020-12-31', '2021-01-01', '2020-12-28', '2021-01-03'],
      ]) {
        const index = cellIndexForDate(origin!, 'week', date!)
        expect(fmtDate(cellStartDate(origin!, 'week', index))).toBe(monday)
        expect(fmtDate(cellEndDate(origin!, 'week', index))).toBe(sunday)
      }
      expect(isoWeek(toDate('2021-01-01'))).toEqual({ year: 2020, week: 53 })
      expect(isoWeek(toDate('2021-01-04'))).toEqual({ year: 2021, week: 1 })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
