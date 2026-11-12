import { describe, expect, it } from 'vitest'
import { resourceScenarioTrace } from '../../tests/fixtures/planningDomain'

describe.each(['day', 'week'] as const)('the nine resource scenarios in %s units', (unit) => {
  const cell = (scenario: number, state: string, date: string, resource = 1) =>
    resourceScenarioTrace(scenario, unit)[state]!.headers[date]![resource - 1]!

  it('1: assigning resources updates every affected header row', () => {
    expect(cell(1, 'before', '2026-11-09').used).toBe(unit === 'week' ? 7 : 0)
    expect(cell(1, 'assigned', '2026-11-09').used).toBe(unit === 'week' ? 9 : 2)
    expect(cell(1, 'assigned', '2026-11-09', 2).used).toBe(3)
    expect(cell(1, 'assigned', '2026-11-09', 3).used).toBe(0)
  })
  it('2: removal retains the other assignments and overlapping tasks', () => {
    expect(cell(2, 'removed', '2026-11-09').used).toBe(unit === 'week' ? 7 : 0)
    expect(cell(2, 'removed', '2026-11-09', 2).used).toBe(3)
  })
  it('3: held movement in both directions changes only preview demand', () => {
    expect(cell(3, 'right', '2026-11-23').used).toBe(2)
    expect(cell(3, 'left', unit === 'week' ? '2026-11-02' : '2026-11-08').used).toBe(2)
    const trace = resourceScenarioTrace(3, unit)
    expect(trace.cancelled).toEqual(trace.before)
  })
  it('4: optimistic movement persists on acceptance and restores on refusal', () => {
    for (const state of ['move-pending', 'move-confirmed']) expect(cell(4, state, '2026-11-23').used).toBe(2)
    expect(cell(4, 'move-rejected', '2026-11-23').used).toBe(0)
  })
  it('5: both resize edges preview, confirm and roll back demand', () => {
    for (const edge of ['left', 'right']) {
      const date = edge === 'right' ? '2026-11-23' : unit === 'week' ? '2026-11-02' : '2026-11-08'
      for (const phase of ['preview', 'pending', 'confirmed']) expect(cell(5, `${edge}-${phase}`, date).used).toBe(2)
      expect(cell(5, `${edge}-rejected`, date).used).toBe(0)
    }
  })
  it('6: resizing recalculates all twelve assigned resources', () => {
    for (let resource = 1; resource <= 12; resource++) {
      for (const phase of ['preview', 'pending', 'confirmed']) expect(cell(6, `right-${phase}`, '2026-11-23', resource).used).toBe(resource + 1)
      expect(cell(6, 'right-rejected', '2026-11-23', resource).used).toBe(0)
    }
  })
  it('7: uses daily values or the weekly peak and minimum, never Monday alone', () => {
    expect(cell(7, 'summary', '2026-11-09')).toMatchObject({ used: unit === 'week' ? 9 : 2, available: unit === 'week' ? 1 : 10 })
    expect(cell(7, 'summary', '2026-11-10')).toMatchObject({ used: 9, available: 1 })
  })
  it('8: adding absence changes only the intended dates/resource and rolls back on refusal', () => {
    for (const phase of ['pending', 'confirmed']) {
      expect(cell(8, phase, '2026-11-18').available).toBe(9)
      expect(cell(8, phase, '2026-11-18', 2).available).toBe(10)
      expect(cell(8, phase, '2026-11-23').available).toBe(10)
    }
    const trace = resourceScenarioTrace(8, unit)
    expect(trace.pending!.periods).toMatchObject([{ state_id: 2, start_date: '2026-11-17', end_date: '2026-11-19' }])
    expect(trace.rejected).toEqual(trace.before)
  })
  it('9: deleting absence restores capacity optimistically and restores absence on refusal', () => {
    expect(cell(9, 'before', '2026-11-18').available).toBe(9)
    for (const phase of ['pending', 'confirmed']) {
      expect(cell(9, phase, '2026-11-18').available).toBe(10)
      expect(cell(9, phase, '2026-11-18', 2).available).toBe(10)
    }
    const trace = resourceScenarioTrace(9, unit)
    expect(trace.pending!.periods).toEqual([])
    expect(trace.rejected).toEqual(trace.before)
  })
})
