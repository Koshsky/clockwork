/**
 * Pure-logic unit tests for useEmployeeFilters (the shared filter state of the
 * Employees / Timesheet pages).
 *
 * The store module is replaced with lightweight stubs (the composable only
 * reads `ts.employees`, `app.users`, `app.resources`, `app.resourceByUser`),
 * so the filter semantics themselves are exercised without a Pinia instance:
 *  - manager options: only non-worker users WITH at least one direct
 *    subordinate in the roster (workers are excluded even when someone
 *    reports to them), sorted by name;
 *  - resources sorted by code+title (ru locale);
 *  - an empty roster yields no manager options;
 *  - applyFilters: search (name+position, case-insensitive) → manager
 *    ('none' / numeric) → resource ('none' / numeric);
 *  - changing the manager filter resets the resource filter;
 *  - resource options are scoped to the selected manager's direct
 *    subordinates (or to manager-less employees for 'none').
 *
 * The composable keeps its filter state at module level, so each test
 * recreates the composable and resets the shared refs it returns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'

const stubs = vi.hoisted(() => ({
  app: { users: [] as Array<Record<string, unknown>>, resources: [] as Array<Record<string, unknown>>, resourceByUser: {} as Record<number, { id: number }> },
  // Filled at module scope below (vi.hoisted cannot reference `ref`).
  ts: {} as { employees: Ref<Array<Record<string, unknown>>> },
}))

vi.mock('../store', () => ({
  useAppStore: () => stubs.app,
  useTimesheetStore: () => stubs.ts,
}))

import { useEmployeeFilters } from './useEmployeeFilters'

/** Stable ref so the composable watchers keep tracking it across tests. */
const employeesRef = ref<Array<Record<string, unknown>>>([])
stubs.ts.employees = employeesRef

function resetStubs(): void {
  stubs.app.users = []
  stubs.app.resources = []
  stubs.app.resourceByUser = {}
  employeesRef.value = []
}

beforeEach(() => {
  resetStubs()
  vi.clearAllMocks()
})

describe('managerFilterOptions', () => {
  it('includes only non-worker users that have at least one direct subordinate, sorted by name', async () => {
    stubs.app.users = [
      { id: 1, preset: 'admin', name: 'Анна' },
      { id: 2, preset: 'manager', name: 'Борис' },
      // A worker — excluded even though someone reports to them.
      { id: 3, preset: 'worker', name: 'Владимир' },
      // A non-worker with NO subordinates — excluded (data filter of the org structure).
      { id: 4, preset: 'admin', name: 'Галина' },
    ]
    employeesRef.value = [
      { id: 11, name: 'Р1', manager_id: 2 },
      { id: 12, name: 'Р2', manager_id: 1 },
      { id: 13, name: 'Р3', manager_id: 2 },
      { id: 14, name: 'Р4', manager_id: 3 }, // subordinate of a worker
    ]

    const ef = useEmployeeFilters()
    // Reset the shared filter so the roster-snapshot watch rebuilds the pool.
    ef.managerFilter.value = ''
    await nextTick()

    expect(ef.managerFilterOptions.value.map((u) => u.name)).toEqual(['Анна', 'Борис'])
  })

  it('is empty for an empty roster (no one with subordinates)', async () => {
    stubs.app.users = [{ id: 1, preset: 'admin', name: 'Анна' }]
    const ef = useEmployeeFilters()
    ef.managerFilter.value = ''
    employeesRef.value = []
    await nextTick()

    expect(ef.managerFilterOptions.value).toEqual([])
  })
})

describe('resourceFilterOptions', () => {
  it('all resources sorted by code+title with no manager filter', () => {
    stubs.app.resources = [
      { id: 2, code: 'b', title: 'Бета' },
      { id: 1, code: 'a', title: 'Альфа' },
      { id: 3, code: 'c', title: 'Гамма' },
    ]
    const ef = useEmployeeFilters()
    ef.managerFilter.value = ''

    expect(ef.resourceFilterOptions.value.map((r) => r.code)).toEqual(['a', 'b', 'c'])
  })

  it('scopes resources to the selected manager\u2019s direct subordinates', () => {
    stubs.app.resources = [
      { id: 7, code: 'r7', title: 'Ресурс 7' },
      { id: 8, code: 'r8', title: 'Ресурс 8' },
    ]
    stubs.app.resourceByUser = { 11: { id: 7 }, 12: { id: 8 } }
    employeesRef.value = [
      { id: 11, name: 'Р1', manager_id: 2 },
      { id: 12, name: 'Р2', manager_id: 1 },
    ]
    const ef = useEmployeeFilters()
    ef.managerFilter.value = ''
    ef.managerFilter.value = 2 // also auto-resets the resource filter

    expect(ef.resourceFilterOptions.value.map((r) => r.id)).toEqual([7])
  })

  it("scopes resources for the 'none' manager filter to manager-less employees", () => {
    stubs.app.resources = [
      { id: 7, code: 'r7', title: 'Ресурс 7' },
      { id: 8, code: 'r8', title: 'Ресурс 8' },
    ]
    stubs.app.resourceByUser = { 11: { id: 7 }, 12: { id: 8 } }
    employeesRef.value = [
      { id: 11, name: 'Р1', manager_id: undefined },
      { id: 12, name: 'Р2', manager_id: 1 },
    ]
    const ef = useEmployeeFilters()
    ef.managerFilter.value = ''
    ef.managerFilter.value = 'none'

    expect(ef.resourceFilterOptions.value.map((r) => r.id)).toEqual([7])
  })
})

describe('applyFilters', () => {
  const roster = [
    { id: 1, name: 'Иван Петров', position: 'Инженер', manager_id: 5, preset: 'worker' },
    { id: 2, name: 'Мария Иванова', position: 'Директор', manager_id: undefined, preset: 'admin' },
    { id: 3, name: 'Пётр Сидоров', position: 'Менеджер', manager_id: 5, preset: 'manager' },
    { id: 4, name: 'Ольга Кузнецова', position: 'Экономист', manager_id: 6, preset: 'worker' },
  ]

  function freshFilters() {
    const ef = useEmployeeFilters()
    ef.search.value = ''
    ef.managerFilter.value = ''
    ef.resourceFilter.value = ''
    return ef
  }

  it('returns the whole list with no filters', () => {
    const ef = freshFilters()
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([1, 2, 3, 4])
  })

  it('filters by search over name and position (case-insensitive)', () => {
    const ef = freshFilters()
    ef.search.value = 'иван'
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([1, 2])
    ef.search.value = 'МЕНЕДЖЕР'
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([3])
  })

  it("filters by manager: 'none' keeps manager-less, numeric keeps the direct scope", () => {
    const ef = freshFilters()
    ef.managerFilter.value = 'none'
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([2])
    ef.managerFilter.value = 5
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([1, 3])
  })

  it("filters by resource: 'none' keeps employees without a resource, numeric keeps the member", () => {
    stubs.app.resourceByUser = { 1: { id: 9 }, 3: { id: 9 }, 4: { id: 8 } }
    const ef = freshFilters()
    ef.resourceFilter.value = 'none'
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([2])
    ef.resourceFilter.value = 9
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([1, 3])
  })

  it('combines search, manager and resource filters', () => {
    stubs.app.resourceByUser = { 1: { id: 9 }, 3: { id: 9 } }
    const ef = freshFilters()
    ef.search.value = 'петров'
    ef.managerFilter.value = 5
    ef.resourceFilter.value = 9
    expect(ef.applyFilters(roster).map((e) => e.id)).toEqual([1])
  })
})

describe('manager filter change resets the resource filter', () => {
  it('switching the manager clears the resource selection', async () => {
    const ef = useEmployeeFilters()
    ef.managerFilter.value = ''
    ef.resourceFilter.value = 9
    ef.managerFilter.value = ''
    // Settle the shared module-level filter state left by earlier tests so the
    // reset watcher below starts from a quiescent scheduler.
    await nextTick()
    ef.resourceFilter.value = 9
    ef.managerFilter.value = 5
    await nextTick()

    expect(ef.resourceFilter.value).toBe('')
  })
})