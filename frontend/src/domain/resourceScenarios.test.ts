import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resourceScenarioIds, resourceScenarioTrace } from '../../tests/fixtures/planningDomain'

const native = {
  ...await vi.importActual<typeof import('./calendar')>('../../desktop/command-calendar.cjs'),
  ...await vi.importActual<typeof import('./planning')>('../../desktop/command-planning.cjs'),
  ...await vi.importActual<typeof import('./timesheet')>('../../desktop/command-timesheet.cjs'),
  ...await vi.importActual<typeof import('./periodAvailability')>('../../desktop/command-periodAvailability.cjs'),
}

describe.each(['day', 'week'] as const)('the nine resource scenarios in %s units', (unit) => {
  const traces = new Map<number, ReturnType<typeof resourceScenarioTrace>>()
  beforeEach(() => traces.clear())
  const traceFor = (scenario: number) => {
    if (!traces.has(scenario)) traces.set(scenario, resourceScenarioTrace(scenario, unit))
    return traces.get(scenario)!
  }
  const cell = (scenario: number, state: string, date: string, resource = 1) =>
    traceFor(scenario)[state]!.headers[date]![resource - 1]!

  it.each(resourceScenarioIds)('scenario %s agrees with the generated main-process transforms', scenario => {
    expect(resourceScenarioTrace(scenario, unit, native)).toEqual(traceFor(scenario))
  })

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
    const trace = traceFor(3)
    expect(trace.cancelled).toEqual(trace.before)
  })
  it('4: a date proposal changes demand and rolling it back restores demand', () => {
    expect(cell(4, 'move-proposed', '2026-11-23').used).toBe(2)
    expect(cell(4, 'move-restored', '2026-11-23').used).toBe(0)
  })
  it('5: both resize proposals match the preview and restore original demand', () => {
    for (const edge of ['left', 'right']) {
      const date = edge === 'right' ? '2026-11-23' : unit === 'week' ? '2026-11-02' : '2026-11-08'
      for (const phase of ['preview', 'proposed']) expect(cell(5, `${edge}-${phase}`, date).used).toBe(2)
      expect(cell(5, `${edge}-restored`, date).used).toBe(0)
    }
  })
  it('6: resizing recalculates all twelve assigned resources', () => {
    for (let resource = 1; resource <= 12; resource++) {
      for (const phase of ['preview', 'proposed']) expect(cell(6, `right-${phase}`, '2026-11-23', resource).used).toBe(resource + 1)
      expect(cell(6, 'right-restored', '2026-11-23', resource).used).toBe(0)
    }
  })
  it('7: uses daily values or the weekly peak and minimum, never Monday alone', () => {
    expect(cell(7, 'summary', '2026-11-09')).toMatchObject({ used: unit === 'week' ? 9 : 2, available: unit === 'week' ? 1 : 10 })
    expect(cell(7, 'summary', '2026-11-10')).toMatchObject({ used: 9, available: 1 })
  })
  it('8: adding and reversing absence changes only the intended dates/resource', () => {
    expect(cell(8, 'proposed', '2026-11-18').available).toBe(9)
    expect(cell(8, 'proposed', '2026-11-18', 2).available).toBe(10)
    expect(cell(8, 'proposed', '2026-11-23').available).toBe(10)
    const trace = traceFor(8)
    expect(trace.proposed!.periods).toMatchObject([{ state_id: 2, start_date: '2026-11-17', end_date: '2026-11-19' }])
    expect(trace.restored).toEqual(trace.before)
  })
  it('9: deleting and restoring absence changes only the intended capacity', () => {
    expect(cell(9, 'before', '2026-11-18').available).toBe(9)
    expect(cell(9, 'proposed', '2026-11-18').available).toBe(10)
    expect(cell(9, 'proposed', '2026-11-18', 2).available).toBe(10)
    const trace = traceFor(9)
    expect(trace.proposed!.periods).toEqual([])
    expect(trace.restored).toEqual(trace.before)
  })
})
