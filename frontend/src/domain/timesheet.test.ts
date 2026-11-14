import { describe, expect, it } from 'vitest'
import { applyRangeSplit, mergePeriodWindow, replaceEmployeeAbsences } from './timesheet'
import { updatePeriodAvailability } from './periodAvailability'
import { indexResourcePeriods, resourceAvailableForDay } from './resourceUsage'
import { toDate } from './calendar'

describe('timesheet projections', () => {
  const period = { id: 1, state_id: 2, state_code: 'leave', is_available: false, start_date: '2026-11-01', end_date: '2026-11-30' }

  it('splits replacement periods without losing outside tails or changing the input', () => {
    const input = [Object.freeze({ ...period })]
    const result = applyRangeSplit(input, 'put', '2026-11-10', '2026-11-12', undefined, { id: -1, state_id: 3, is_available: false })
    expect(result.map((p) => [p.state_id, p.start_date, p.end_date])).toEqual([
      [2, '2026-11-01', '2026-11-09'], [3, '2026-11-10', '2026-11-12'], [2, '2026-11-13', '2026-11-30'],
    ])
    expect(input).toEqual([period])
  })
  it.each([undefined, 2, 3])('deletes only the intended state (%s), preserving tails', (stateId) => {
    const result = applyRangeSplit([period], 'delete', '2026-11-10', '2026-11-12', stateId)
    expect(result.map((p) => [p.start_date, p.end_date])).toEqual(stateId === 3
      ? [['2026-11-01', '2026-11-30']]
      : [['2026-11-01', '2026-11-09'], ['2026-11-13', '2026-11-30']])
  })
  it('keeps window data outside the loaded range and trusts an empty response inside it', () => {
    const before = { ...period, id: 1, end_date: '2026-11-08' }
    const inside = { ...period, id: 2, start_date: '2026-11-10', end_date: '2026-11-12' }
    const after = { ...period, id: 3, start_date: '2026-11-20' }
    const existing = [before, inside, after]
    expect(mergePeriodWindow(existing, [], '2026-11-10', '2026-11-12')).toEqual([before, after])
    expect(existing).toEqual([before, inside, after])
  })
  it('deduplicates fresh period ids and sorts them without mutating either input', () => {
    const old = [{ ...period, id: 1, start_date: '2026-11-25' }]
    const fresh = [{ ...period, id: 2, end_date: '2026-11-09' }, { ...period, id: 2, end_date: '2026-11-10' }]
    const result = mergePeriodWindow(old, fresh, '2026-11-01', '2026-11-10')
    expect(result.map((p) => [p.id, p.end_date])).toEqual([[2, '2026-11-10'], [1, '2026-11-30']])
    expect(fresh).toHaveLength(2)
    expect(old).toHaveLength(1)
  })
  it('retains equal snapshot identity to prevent refresh flicker', () => {
    const existing = [period]
    expect(mergePeriodWindow(existing, [{ ...period }], '2026-11-01', '2026-11-30')).toBe(existing)
  })
  it('replaces only the edited employee absence listing', () => {
    const existing = [{ user_id: 51, state_id: 2 }, { user_id: 52, state_id: 2 }]
    const next = replaceEmployeeAbsences(existing, [period, { ...period, state_id: 3, is_available: true }], 51, 'Employee')
    expect(next).toEqual([existing[1], {
      user_id: 51, user_name: 'Employee', state_id: 2, state_code: 'leave', state_name: undefined,
      start_date: '2026-11-01', end_date: '2026-11-30',
    }])
    expect(existing).toHaveLength(2)
  })
})

describe('absence capacity deltas', () => {
  const calendar = () => [{ resource_id: 1, periods: [{ start_date: '2026-11-01', end_date: '2026-11-30', capacity: 10, unavailable: 0, available: 10 }] },
    { resource_id: 2, periods: [{ start_date: '2026-11-01', end_date: '2026-11-30', capacity: 8, unavailable: 0, available: 8 }] }]
  const absent = [{ state_id: 2, start_date: '2026-11-10', end_date: '2026-11-12', is_available: false }]

  it('changes only the chosen resource and days; reversing the delta restores capacity', () => {
    const original = calendar()
    const copy = structuredClone(original)
    const changed = updatePeriodAvailability(original, 1, [], absent, '2026-11-10', '2026-11-12')
    const index = indexResourcePeriods(changed)
    expect(original).toEqual(copy)
    expect(changed[1]).toBe(original[1])
    for (const date of ['2026-11-09', '2026-11-13']) expect(resourceAvailableForDay(index, 1, toDate(date))).toBe(10)
    for (const date of ['2026-11-10', '2026-11-11', '2026-11-12']) expect(resourceAvailableForDay(index, 1, toDate(date))).toBe(9)
    expect(resourceAvailableForDay(index, 2, toDate('2026-11-11'))).toBe(8)
    const restored = indexResourcePeriods(updatePeriodAvailability(changed, 1, absent, [], '2026-11-10', '2026-11-12'))
    expect(resourceAvailableForDay(restored, 1, toDate('2026-11-11'))).toBe(10)
  })
  it('does not count an employee twice when changing absence type', () => {
    const first = updatePeriodAvailability(calendar(), 1, [], absent, '2026-11-10', '2026-11-12')
    const second = updatePeriodAvailability(first, 1, absent, [{ ...absent[0], state_id: 3 }], '2026-11-10', '2026-11-12')
    expect(resourceAvailableForDay(indexResourcePeriods(second), 1, toDate('2026-11-11'))).toBe(9)
  })
  it('never invents availability outside the loaded range', () => {
    const changed = updatePeriodAvailability(calendar(), 1, [], absent, '2026-11-10', '2026-11-12')
    expect(resourceAvailableForDay(indexResourcePeriods(changed), 1, toDate('2026-12-01'))).toBeNull()
  })
})
