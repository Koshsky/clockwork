/**
 * Local-first date patch of a dragged bar — projects, processes and the single
 * task/milestone fallbacks.
 *
 * The drag preview is cleared on pointer-up (`useBarDrag.endDrag`) BEFORE the
 * store learns the new dates, so a row patched only after the PUT and the
 * following silent reload makes the bar snap back to its old span and then jump
 * to the dropped one — the reported "bars jump when moving projects/processes".
 * Task bars never had the defect: `moveTask` → `persistDatePatches` already
 * mutates the rows synchronously, in the same tick as the pointer-up handler.
 *
 * What is asserted here is therefore the SYNCHRONOUS contract — the store row
 * carries the dropped span before the request promise resolves (the diagram
 * renders once, already in the new place) — plus the rollback contract: a move
 * the server rejects must not leave a fabricated span on screen (the silent
 * reload in `onError` restores the server dates).
 *
 * The generated API client is replaced by class-shaped mocks (as in
 * `index.test.ts`) and every response is shaped like the real envelope the store
 * unwraps: `{ data: { data: <payload> } }`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { pendingRefs } from '@/offline/outbox'
import { useAppStore, usePlanningStore, useTimesheetStore, useAuthStore } from './index'

/** Mutable per-test method implementations for the mocked API classes. */
const api = vi.hoisted(() => ({
  resourcesPost: vi.fn(),
  resourcesIdPut: vi.fn(),
  processIdPut: vi.fn(),
  projectIdPut: vi.fn(),
  projectGet: vi.fn(),
  milestoneIdPut: vi.fn(),
  taskIdPut: vi.fn(),
  userIdDaysPut: vi.fn(),
  userIdDaysDelete: vi.fn(),
  userDaysGet: vi.fn(),
  timesheetCalendarGet: vi.fn(),
  assignmentPost: vi.fn(),
  assignmentIdDelete: vi.fn(),
  planningProcessesGet: vi.fn(),
  planningProjectsGet: vi.fn(),
  planningTasksGet: vi.fn(),
}))

vi.mock('@/api', () => {
  class ProcessesApi {
    processIdPut(...args: unknown[]) {
      return api.processIdPut(...args)
    }
  }
  class ProjectsApi {
    projectIdPut(...args: unknown[]) {
      return api.projectIdPut(...args)
    }
    projectGet(...args: unknown[]) {
      return api.projectGet(...args)
    }
  }
  class MilestonesApi {
    milestoneIdPut(...args: unknown[]) {
      return api.milestoneIdPut(...args)
    }
  }
  class TasksApi {
    taskIdPut(...args: unknown[]) {
      return api.taskIdPut(...args)
    }
  }
  class PlanningApi {
    planningProcessesGet(...args: unknown[]) {
      return api.planningProcessesGet(...args)
    }
    planningProjectsGet(...args: unknown[]) {
      return api.planningProjectsGet(...args)
    }
    planningTasksGet(...args: unknown[]) {
      return api.planningTasksGet(...args)
    }
  }
  class Configuration {
    constructor(opts?: unknown) {
      Object.assign(this, opts ?? {})
    }
  }
  return {
    AuthApi: class {},
    ProcessesApi,
    ProjectsApi,
    MilestonesApi,
    TasksApi,
    PlanningApi,
    TimesheetResourcesApi: class { resourcesPost(...args: unknown[]) { return api.resourcesPost(...args) } resourcesIdPut(...args: unknown[]) { return api.resourcesIdPut(...args) } },
    TimesheetCalendarApi: class { timesheetCalendarGet(...args: unknown[]) { return api.timesheetCalendarGet(...args) } },
    TimesheetStatesApi: class {},
    UsersApi: class {
      userIdDaysPut(...args: unknown[]) { return api.userIdDaysPut(...args) }
      userIdDaysDelete(...args: unknown[]) { return api.userIdDaysDelete(...args) }
      userDaysGet(...args: unknown[]) { return api.userDaysGet(...args) }
    },
    AssignmentsApi: class {
      assignmentPost(...args: unknown[]) { return api.assignmentPost(...args) }
      assignmentIdDelete(...args: unknown[]) { return api.assignmentIdDelete(...args) }
    },
    AutoCreateApi: class {},
    RBACApi: class {},
    PermissionsApi: class {},
    AuditApi: class {},
    Configuration,
  }
})

/** Envelope of a successful GET (`refreshX` reads `resp.data.data`). */
function payload<T>(data: T): { data: { data: T } } {
  return { data: { data } }
}

/** Callbacks captured by the stubbed `window.setTimeout` (see runCoalescedRefresh) */
const scheduledTimers: Array<() => void> = []

/** Lets a fire-and-forget continuation (the rollback reload) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let planning: ReturnType<typeof usePlanningStore>
let app: ReturnType<typeof useAppStore>

/**
 * Runs the coalesced post-mutation refresh (`scheduleDomainRefresh` → 400 ms
 * debounce). The node env has no timers to wait for, so the stub collects the
 * callbacks and the tests run them explicitly — that is what makes the request
 * COUNT per aggregate assertable (the "one re-read per burst" contract).
 */
async function runCoalescedRefresh(): Promise<void> {
  const callbacks = scheduledTimers.splice(0)
  for (const cb of callbacks) cb()
  // flushDomainRefresh awaits one reloader per pending domain — let them land.
  await tick()
}

beforeAll(() => {
  // The auth store subscribes to the cross-tab session channel on creation and
  // the coalesced post-mutation refresh arms a timer — inert stubs for node.
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: (cb: () => void) => {
      scheduledTimers.push(cb)
      return scheduledTimers.length
    },
    clearTimeout: vi.fn(),
  })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  setActivePinia(createPinia())
  planning = usePlanningStore()
  app = useAppStore()
  vi.clearAllMocks()
})

afterEach(async () => {
  // A queued flush would otherwise leak into the next test (the module keeps the
  // armed-timer flag until the flush runs).
  await runCoalescedRefresh()
})

describe('updateProcessDates — the dropped span applies before the request', () => {
  beforeEach(() => {
    planning.processPlanning = {
      projects: [
        {
          id: 1,
          start_date: '2026-01-01',
          end_date: '2026-03-01',
          processes: [{ id: 10, start_date: '2026-01-05', end_date: '2026-01-20' }],
        },
      ],
    }
  })

  it('patches the process row synchronously, then applies the echoed server row', async () => {
    api.processIdPut.mockResolvedValue(
      payload({ id: 10, start_date: '2026-01-08', end_date: '2026-01-23' }),
    )
    api.planningProcessesGet.mockResolvedValue(
      payload({
        projects: [
          {
            id: 1,
            start_date: '2026-01-01',
            end_date: '2026-03-01',
            processes: [{ id: 10, start_date: '2026-01-08', end_date: '2026-01-23' }],
          },
        ],
      }),
    )

    const pending = planning.updateProcessDates(10, '2026-01-08', '2026-01-23')

    // No await yet: the bar must already be at the drop point (one render).
    expect(planning.processPlanning?.projects?.[0]?.processes?.[0]?.start_date).toBe('2026-01-08')
    expect(planning.processPlanning?.projects?.[0]?.processes?.[0]?.end_date).toBe('2026-01-23')

    await expect(pending).resolves.toBe(true)
    // No immediate re-read: apply() uses the PUT payload.
    expect(api.planningProcessesGet).not.toHaveBeenCalled()
    expect(planning.processPlanning?.projects?.[0]?.processes?.[0]?.start_date).toBe('2026-01-08')
  })

  it('rolls the rejected span back to the server dates', async () => {
    api.processIdPut.mockRejectedValue(new Error('400: dates outside the project'))
    api.planningProcessesGet.mockResolvedValue(
      payload({
        projects: [
          {
            id: 1,
            start_date: '2026-01-01',
            end_date: '2026-03-01',
            processes: [{ id: 10, start_date: '2026-02-25', end_date: '2026-02-27' }],
          },
        ],
      }),
    )

    await expect(planning.updateProcessDates(10, '2026-02-25', '2026-03-10')).resolves.toBe(false)
    expect(planning.error).toBeTruthy()

    // The rollback reload runs in the background (fire-and-forget).
    await tick()
    expect(api.planningProcessesGet).toHaveBeenCalled()
    expect(planning.processPlanning?.projects?.[0]?.processes?.[0]?.start_date).toBe('2026-02-25')
    expect(planning.processPlanning?.projects?.[0]?.processes?.[0]?.end_date).toBe('2026-02-27')
  })
})

describe('updateProjectDates — both copies of the project take the drop at once', () => {
  beforeEach(() => {
    planning.projectPlanning = {
      projects: [{ id: 5, project_code: 'P-5', start_date: '2026-01-01', end_date: '2026-03-01' }],
    }
    // The projects table reads the app store list (same pairing as updateProjectMeta).
    app.projects = [{ id: 5, project_code: 'P-5', start_date: '2026-01-01', end_date: '2026-03-01' }]
  })

  it('patches the planning aggregate and the app store list synchronously', async () => {
    api.projectIdPut.mockResolvedValue(payload({ id: 5 }))
    api.planningProjectsGet.mockResolvedValue(
      payload({ projects: [{ id: 5, project_code: 'P-5', start_date: '2026-01-06', end_date: '2026-03-06' }] }),
    )

    const pending = planning.updateProjectDates(5, '2026-01-06', '2026-03-06')

    expect(planning.projectPlanning?.projects?.[0]?.start_date).toBe('2026-01-06')
    expect(planning.projectPlanning?.projects?.[0]?.end_date).toBe('2026-03-06')
    expect(app.projects[0]?.start_date).toBe('2026-01-06')
    expect(app.projects[0]?.end_date).toBe('2026-03-06')

    await expect(pending).resolves.toBe(true)
  })

  it('restores the server span when the move is rejected', async () => {
    api.projectIdPut.mockRejectedValue(new Error('409: conflict'))
    api.planningProjectsGet.mockResolvedValue(
      payload({ projects: [{ id: 5, project_code: 'P-5', start_date: '2026-01-01', end_date: '2026-03-01' }] }),
    )
    api.projectGet.mockResolvedValue(
      payload({ items: [{ id: 5, project_code: 'P-5', start_date: '2026-01-01', end_date: '2026-03-01' }] }),
    )

    await expect(planning.updateProjectDates(5, '2026-01-06', '2026-03-06')).resolves.toBe(false)
    expect(planning.error).toBeTruthy()

    await tick()
    expect(planning.projectPlanning?.projects?.[0]?.start_date).toBe('2026-01-01')
    expect(app.projects[0]?.start_date).toBe('2026-01-01')
  })
})

describe('the single-date fallbacks share the same contract', () => {
  beforeEach(() => {
    planning.taskPlanning = {
      processes: [
        {
          id: 1,
          tasks: [{ id: 7, start_date: '2026-01-05', end_date: '2026-01-09' }],
          milestones: [{ id: 3, date: '2026-01-05' }],
        },
      ],
    }
  })

  it('updateTaskDates (a task without its process context) applies the span synchronously', async () => {
    api.taskIdPut.mockResolvedValue(payload({ id: 7 }))
    api.planningTasksGet.mockResolvedValue(
      payload({ processes: [{ id: 1, tasks: [{ id: 7, start_date: '2026-01-12', end_date: '2026-01-16' }] }] }),
    )

    const pending = planning.updateTaskDates(7, '2026-01-12', '2026-01-16')

    expect(planning.taskPlanning?.processes?.[0]?.tasks?.[0]?.start_date).toBe('2026-01-12')
    expect(planning.taskPlanning?.processes?.[0]?.tasks?.[0]?.end_date).toBe('2026-01-16')

    await expect(pending).resolves.toBe(true)
  })

  it('updateMilestoneDate moves the marker date synchronously', async () => {
    api.milestoneIdPut.mockResolvedValue(payload({ id: 3 }))
    api.planningTasksGet.mockResolvedValue(
      payload({ processes: [{ id: 1, milestones: [{ id: 3, date: '2026-01-14' }] }] }),
    )

    const pending = planning.updateMilestoneDate(3, '2026-01-14')

    expect(planning.taskPlanning?.processes?.[0]?.milestones?.[0]?.date).toBe('2026-01-14')

    await expect(pending).resolves.toBe(true)
  })
})

describe('one re-read per aggregate per mutation (no duplicate GET)', () => {
  // The duplicate seen in the network tab came from the action's own apply()
  // refresh plus the coalesced post-mutation refresh of the SAME aggregate
  // (reloadDomainsFor). apply() now uses the PUT payload, so the aggregate is
  // re-read exactly once, by the coalesced flush — together with the aggregates
  // the server-side triggers touch (tasks/projects of a moved process).
  beforeEach(() => {
    planning.processPlanning = {
      projects: [
        {
          id: 1,
          start_date: '2026-01-01',
          end_date: '2026-03-01',
          processes: [{ id: 10, title: 'P', start_date: '2026-01-05', end_date: '2026-01-20' }],
        },
      ],
    }
    planning.projectPlanning = {
      projects: [{ id: 5, project_code: 'P-5', start_date: '2026-01-01', end_date: '2026-03-01' }],
    }
    planning.taskPlanning = {
      processes: [
        {
          id: 1,
          tasks: [
            { id: 7, start_date: '2026-01-05', end_date: '2026-01-09' },
            { id: 8, start_date: '2026-01-05', end_date: '2026-01-09' },
          ],
        },
      ],
    }
    app.projects = [{ id: 5, project_code: 'P-5', start_date: '2026-01-01', end_date: '2026-03-01' }]

    api.processIdPut.mockResolvedValue(payload({ id: 10, start_date: '2026-01-08', end_date: '2026-01-23' }))
    api.projectIdPut.mockResolvedValue(payload({ id: 5, start_date: '2026-01-06', end_date: '2026-03-06' }))
    api.taskIdPut.mockResolvedValue(payload({ id: 7, start_date: '2026-01-12', end_date: '2026-01-16' }))
    api.planningProcessesGet.mockResolvedValue(payload({ projects: [] }))
    api.planningProjectsGet.mockResolvedValue(payload({ projects: [] }))
    api.planningTasksGet.mockResolvedValue(payload({ processes: [] }))
    api.projectGet.mockResolvedValue(payload({ items: [] }))
  })

  it('a process move re-reads /planning/processes once (plus the trigger-cascade neighbours)', async () => {
    await planning.updateProcessDates(10, '2026-01-08', '2026-01-23')

    expect(api.processIdPut).toHaveBeenCalledTimes(1)
    expect(api.planningProcessesGet).not.toHaveBeenCalled()

    await runCoalescedRefresh()

    expect(api.planningProcessesGet).toHaveBeenCalledTimes(1)
    expect(api.planningTasksGet).toHaveBeenCalledTimes(1)
    expect(api.planningProjectsGet).toHaveBeenCalledTimes(1)
  })

  it('a project move re-reads /planning/projects once (plus /projects and the cascade)', async () => {
    await planning.updateProjectDates(5, '2026-01-06', '2026-03-06')

    expect(api.projectIdPut).toHaveBeenCalledTimes(1)
    expect(api.planningProjectsGet).not.toHaveBeenCalled()

    await runCoalescedRefresh()

    expect(api.planningProjectsGet).toHaveBeenCalledTimes(1)
    expect(api.projectGet).toHaveBeenCalledTimes(1)
    expect(api.planningProcessesGet).toHaveBeenCalledTimes(1)
    expect(api.planningTasksGet).toHaveBeenCalledTimes(1)
  })

  it('a process edit from the modal behaves the same way', async () => {
    await planning.updateProcessMeta(10, { title: 'renamed' })

    expect(api.planningProcessesGet).not.toHaveBeenCalled()

    await runCoalescedRefresh()

    expect(api.planningProcessesGet).toHaveBeenCalledTimes(1)
  })

  it('a burst of bar moves collapses into a single GET per aggregate', async () => {
    await planning.updateTaskDates(7, '2026-01-12', '2026-01-16')
    await planning.updateTaskDates(8, '2026-01-12', '2026-01-16')

    expect(api.taskIdPut).toHaveBeenCalledTimes(2)
    expect(api.planningTasksGet).not.toHaveBeenCalled()

    await runCoalescedRefresh()

    expect(api.planningTasksGet).toHaveBeenCalledTimes(1)
  })
})


describe('task drag and resize persistence', () => {
  const original = { start_date: '2026-11-09', end_date: '2026-11-22' }
  beforeEach(() => {
    planning.taskPlanning = { processes: [{ id: 1, tasks: [{ id: 7, ...original }] }] }
    api.planningTasksGet.mockRejectedValue(new Error('reload unavailable'))
  })

  it.each([
    ['move right', '2026-11-16', '2026-11-29'],
    ['move left', '2026-11-02', '2026-11-15'],
    ['resize start', '2026-11-16', '2026-11-22'],
    ['resize end', '2026-11-09', '2026-11-29'],
  ])('%s keeps pending dates and applies the accepted server span', async (_, start_date, end_date) => {
    let accept!: (value: unknown) => void
    api.taskIdPut.mockImplementation(() => new Promise((resolve) => { accept = resolve }))
    const pending = planning.moveTask(7, start_date, end_date)
    const row = planning.taskPlanning!.processes![0].tasks![0]
    expect(row).toMatchObject({ start_date, end_date })
    expect(api.taskIdPut).toHaveBeenCalledExactlyOnceWith(7, { start_date, end_date })
    accept(payload({ ...original }))
    await expect(pending).resolves.toBe(true)
    expect(row).toMatchObject(original)
  })

  it.each(['moveTask', 'updateTaskDates'] as const)('%s restores confirmed dates even if reconciliation fails', async (action) => {
    api.taskIdPut.mockRejectedValue(new Error('409: rejected'))
    await expect(planning[action](7, '2026-11-16', '2026-11-29')).resolves.toBe(false)
    await tick()
    expect(planning.taskPlanning!.processes![0].tasks![0]).toMatchObject(original)
    expect(planning.error).toBeTruthy()
  })

  it('preserves accepted predecessors and restores rejected and unsubmitted successors', async () => {
    planning.taskPlanning = { processes: [{ id: 1, tasks: [
      { id: 7, ...original },
      { id: 8, start_date: '2026-11-23', end_date: '2026-11-29' },
      { id: 9, start_date: '2026-11-30', end_date: '2026-12-06' },
    ], dependencies: [
      { id: 1, task_id: 8, depends_on_task_id: 7, type: 'fs' },
      { id: 2, task_id: 9, depends_on_task_id: 8, type: 'fs' },
    ] }] }
    api.taskIdPut.mockResolvedValueOnce(payload({ start_date: '2026-11-23', end_date: '2026-12-06' }))
      .mockRejectedValueOnce(new Error('409: successor rejected'))
    await expect(planning.moveTask(7, '2026-11-23', '2026-12-06')).resolves.toBe(false)
    expect(api.taskIdPut).toHaveBeenCalledTimes(2)
    expect(planning.taskPlanning!.processes![0].tasks).toMatchObject([
      { id: 7, start_date: '2026-11-23', end_date: '2026-12-06' },
      { id: 8, start_date: '2026-11-23', end_date: '2026-11-29' },
      { id: 9, start_date: '2026-11-30', end_date: '2026-12-06' },
    ])
  })
})


describe('resource assignment persistence', () => {
  beforeEach(() => {
    planning.taskPlanning = { processes: [{ id: 1, tasks: [{ id: 7, resources: [] }] }] }
  })

  it('adds the confirmed assignment from the planning response', async () => {
    let accept!: (value: unknown) => void
    api.assignmentPost.mockImplementation(() => new Promise((resolve) => { accept = resolve }))
    const resources = [{ id: 3, assignment_id: 41, quantity: 4 }]
    api.planningTasksGet.mockResolvedValue(payload({ processes: [{ id: 1, tasks: [{ id: 7, resources }] }] }))
    const pending = planning.assignResource(7, 3, 4)
    expect(api.assignmentPost).toHaveBeenCalledExactlyOnceWith({ task_id: 7, resource_id: 3, quantity: 4 })
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toMatchObject([{ id: 3, quantity: 4 }])
    accept(payload({ id: 41 }))
    await expect(pending).resolves.toBe(true)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toEqual(resources)
  })

  it('removes only the confirmed assignment using its assignment id', async () => {
    planning.taskPlanning!.processes![0].tasks![0].resources = [{ id: 3, assignment_id: 41, quantity: 4 }, { id: 4, assignment_id: 42, quantity: 5 }]
    api.assignmentIdDelete.mockResolvedValue(payload(null))
    api.planningTasksGet.mockResolvedValue(payload({ processes: [{ id: 1, tasks: [{ id: 7, resources: [{ id: 4, assignment_id: 42, quantity: 5 }] }] }] }))
    await expect(planning.removeResource(7, 3)).resolves.toBe(true)
    expect(api.assignmentIdDelete).toHaveBeenCalledExactlyOnceWith(41)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toEqual([{ id: 4, assignment_id: 42, quantity: 5 }])
  })

  it('keeps resource loads unchanged on rejected assignment and removal', async () => {
    api.assignmentPost.mockRejectedValue(new Error('403: forbidden'))
    await expect(planning.assignResource(7, 3, 4)).resolves.toBe(false)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toEqual([])
    const assigned = [{ id: 3, assignment_id: 41, quantity: 4 }]
    planning.taskPlanning!.processes![0].tasks![0].resources = assigned
    api.assignmentIdDelete.mockRejectedValue(new Error('409: conflict'))
    await expect(planning.removeResource(7, 3)).resolves.toBe(false)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toEqual(assigned)
  })
})


describe('task mutation response status', () => {
  beforeEach(() => {
    planning.taskPlanning = { processes: [{ id: 1, tasks: [{ id: 7, start_date: '2026-11-09', end_date: '2026-11-22' }] }] }
    api.planningTasksGet.mockRejectedValue(new Error('reload unavailable'))
  })

  it('rejects an error envelope even when HTTP succeeded', async () => {
    api.taskIdPut.mockResolvedValue({ data: { data: null, error: { code: 409, message: 'Rejected dates' } } })
    await expect(planning.moveTask(7, '2026-11-16', '2026-11-29')).resolves.toBe(false)
    expect(planning.taskPlanning!.processes![0].tasks![0]).toMatchObject({ start_date: '2026-11-09', end_date: '2026-11-22' })
  })

  it('does not mistake an empty error object for failure', async () => {
    api.taskIdPut.mockResolvedValue({ data: { data: { start_date: '2026-11-16', end_date: '2026-11-29' }, error: {} } })
    await expect(planning.moveTask(7, '2026-11-16', '2026-11-29')).resolves.toBe(true)
  })

  it('does not overwrite a newer edit when an older request fails', async () => {
    let reject!: (reason: Error) => void
    api.taskIdPut.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const first = planning.moveTask(7, '2026-11-16', '2026-11-29')
    api.taskIdPut.mockResolvedValueOnce(payload({ start_date: '2026-11-23', end_date: '2026-12-06' }))
    await planning.moveTask(7, '2026-11-23', '2026-12-06')
    reject(new Error('409: older move failed'))
    await expect(first).resolves.toBe(false)
    expect(planning.taskPlanning!.processes![0].tasks![0]).toMatchObject({ start_date: '2026-11-23', end_date: '2026-12-06' })
  })
})


describe('optimistic timesheet absence and resource capacity transaction', () => {
  let timesheet: ReturnType<typeof useTimesheetStore>
  beforeEach(() => {
    timesheet = useTimesheetStore()
    timesheet.employees = [{ id: 51, name: 'Employee' }]
    timesheet.states = [{ id: 2, code: 'leave', is_available: false }, { id: 3, code: 'sick', is_available: false }, { id: 4, code: 'work', is_available: true }]
    timesheet.periodsByEmployee = { 51: [] }
    timesheet.windowStart = '2026-11-01'
    timesheet.windowEnd = '2026-11-30'
    app.resources = [{ id: 1 }, { id: 2 }]
    app.resourceMembers = { 1: [{ id: 51 }] }
    app.calendar = [1, 2].map((resource_id) => ({ resource_id, periods: [{ start_date: '2026-11-01', end_date: '2026-11-30', capacity: 10, unavailable: 0, available: 10 }] }))
    api.userDaysGet.mockImplementation(() => Promise.resolve(payload([{ user_id: 51, days: timesheet.periodsByEmployee[51].map((p, i) => ({ ...p, id: 100 + i })) }])))
    api.timesheetCalendarGet.mockImplementation(() => Promise.resolve(payload({ resources: app.calendar })))
  })
  const available = (date: string, id = 1) => app.calendar.find((r) => r.resource_id === id)?.periods?.find((p) => p.start_date! <= date && p.end_date! >= date)?.available

  it.each([true, false])('adding an absence previews immediately; accepted=%s', async (accepted) => {
    let respond!: () => void
    api.userIdDaysPut.mockImplementation(() => new Promise((resolve, reject) => {
      respond = () => accepted ? resolve(payload(null)) : reject(new Error('409: rejected'))
    }))
    const pending = timesheet.assignRange(51, 2, '2026-11-10', '2026-11-12')
    expect(timesheet.periodFor(51, '2026-11-11')?.state_id).toBe(2)
    expect(available('2026-11-09')).toBe(10)
    expect(available('2026-11-10')).toBe(9)
    expect(available('2026-11-12')).toBe(9)
    expect(available('2026-11-13')).toBe(10)
    expect(available('2026-11-11', 2)).toBe(10)
    // A background pull cannot overwrite the pending local transaction.
    await app.refreshCalendar()
    await timesheet.refreshPeriods('2026-11-01', '2026-11-30')
    expect(api.timesheetCalendarGet).not.toHaveBeenCalled()
    expect(api.userDaysGet).not.toHaveBeenCalled()
    respond()
    await expect(pending).resolves.toBe(accepted)
    expect(available('2026-11-11')).toBe(accepted ? 9 : 10)
    expect(timesheet.periodFor(51, '2026-11-11')?.state_id).toBe(accepted ? 2 : undefined)
  })

  it.each([true, false])('deleting part of an absence keeps its tails; accepted=%s', async (accepted) => {
    api.userIdDaysPut.mockResolvedValue(payload(null))
    await timesheet.assignRange(51, 2, '2026-11-09', '2026-11-15')
    let respond!: () => void
    api.userIdDaysDelete.mockImplementation(() => new Promise((resolve, reject) => {
      respond = () => accepted ? resolve(payload(null)) : reject(new Error('403: rejected'))
    }))
    const pending = timesheet.clearRange(51, '2026-11-10', '2026-11-12')
    expect(timesheet.periodFor(51, '2026-11-11')).toBeUndefined()
    expect(available('2026-11-11')).toBe(10)
    expect(available('2026-11-09')).toBe(9)
    expect(available('2026-11-13')).toBe(9)
    respond()
    await expect(pending).resolves.toBe(accepted)
    expect(available('2026-11-11')).toBe(accepted ? 10 : 9)
    expect(timesheet.periodFor(51, '2026-11-11')?.state_id).toBe(accepted ? undefined : 2)
  })

  it('replacing one absence by another does not subtract an employee twice', async () => {
    api.userIdDaysPut.mockResolvedValue(payload(null))
    api.userIdDaysDelete.mockResolvedValue(payload(null))
    await timesheet.assignRange(51, 2, '2026-11-09', '2026-11-15')
    await timesheet.assignRange(51, 3, '2026-11-11', '2026-11-13')
    expect(available('2026-11-12')).toBe(9)
    await timesheet.clearRange(51, '2026-11-09', '2026-11-15', 2)
    expect(available('2026-11-10')).toBe(10)
    expect(available('2026-11-12')).toBe(9)
    await timesheet.assignRange(51, 4, '2026-11-12', '2026-11-12')
    expect(available('2026-11-12')).toBe(10)
    expect(available('2026-11-11')).toBe(9)
  })

  it('ignores calendar and period reads started before a mutation', async () => {
    let calendarReply!: (value: unknown) => void
    let periodsReply!: (value: unknown) => void
    const oldCalendar = app.calendar
    api.timesheetCalendarGet.mockImplementationOnce(() => new Promise((resolve) => { calendarReply = resolve }))
    api.userDaysGet.mockImplementationOnce(() => new Promise((resolve) => { periodsReply = resolve }))
    const reads = [app.refreshCalendar(), timesheet.refreshPeriods('2026-11-01', '2026-11-30')]
    api.userIdDaysPut.mockResolvedValue(payload(null))
    await timesheet.assignRange(51, 2, '2026-11-10', '2026-11-12')
    calendarReply(payload({ resources: oldCalendar }))
    periodsReply(payload([{ user_id: 51, days: [] }]))
    await Promise.all(reads)
    expect(available('2026-11-11')).toBe(9)
    expect(timesheet.periodFor(51, '2026-11-11')?.state_id).toBe(2)
  })
})


describe('background planning reads never replace unconfirmed edits', () => {
  beforeEach(() => {
    planning.taskPlanning = { processes: [{ id: 1, tasks: [{ id: 7, start_date: '2026-11-09', end_date: '2026-11-22', resources: [] }] }] }
    pendingRefs.value = new Set()
  })
  afterEach(() => { pendingRefs.value = new Set() })

  it.each(['dates', 'assignment'] as const)('ignores a GET started before pending %s', async (kind) => {
    const old = JSON.parse(JSON.stringify(planning.taskPlanning))
    let reply!: (value: unknown) => void
    api.planningTasksGet.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve }))
    const read = planning.refreshTaskPlanning(true)
    let accept!: (value: unknown) => void
    const mutation = kind === 'dates' ? api.taskIdPut : api.assignmentPost
    mutation.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve }))
    const pending = kind === 'dates'
      ? planning.moveTask(7, '2026-11-16', '2026-11-29')
      : planning.assignResource(7, 3, 4)
    reply(payload(old))
    await read
    const row = planning.taskPlanning!.processes![0].tasks![0]
    if (kind === 'dates') expect(row.start_date).toBe('2026-11-16')
    else expect(row.resources).toMatchObject([{ id: 3, quantity: 4 }])
    api.planningTasksGet.mockResolvedValue(payload(planning.taskPlanning))
    accept(payload({ id: 41 }))
    await expect(pending).resolves.toBe(true)
  })

  it('ignores a GET started during a write even when it arrives after acceptance', async () => {
    const old = JSON.parse(JSON.stringify(planning.taskPlanning))
    let accept!: (value: unknown) => void
    api.taskIdPut.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve }))
    const pending = planning.moveTask(7, '2026-11-16', '2026-11-29')
    let reply!: (value: unknown) => void
    api.planningTasksGet.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve }))
    const read = planning.refreshTaskPlanning(true)
    accept(payload({ start_date: '2026-11-16', end_date: '2026-11-29' }))
    await pending
    reply(payload(old))
    await read
    expect(planning.taskPlanning!.processes![0].tasks![0].start_date).toBe('2026-11-16')
    api.planningTasksGet.mockResolvedValue(payload(old))
    await planning.refreshTaskPlanning(true)
    expect(planning.taskPlanning!.processes![0].tasks![0].start_date).toBe('2026-11-09')
  })

  it('keeps offline queue edits while allowing a clean read after the queue is drained', async () => {
    const old = JSON.parse(JSON.stringify(planning.taskPlanning))
    planning.taskPlanning!.processes![0].tasks![0].start_date = '2026-11-16'
    pendingRefs.value = new Set(['task:7'])
    api.planningTasksGet.mockResolvedValue(payload(old))
    await planning.refreshTaskPlanning(true)
    expect(planning.taskPlanning!.processes![0].tasks![0].start_date).toBe('2026-11-16')
    pendingRefs.value = new Set()
    await planning.refreshTaskPlanning(true)
    expect(planning.taskPlanning!.processes![0].tasks![0].start_date).toBe('2026-11-09')
  })
})


describe('assignment cleanup on owner changes', () => {
  beforeEach(() => {
    app.resources = [{ id: 3, owner_id: 1 }]
    planning.taskPlanning = { processes: [
      { id: 10, owner_id: 1, tasks: [{ id: 7, resources: [{ id: 3 }, { id: 4 }] }] },
      { id: 11, owner_id: 1, tasks: [{ id: 8, resources: [{ id: 4 }] }] },
    ] }
  })
  it('changing resource owner removes only this resource assignments', async () => {
    api.resourcesIdPut.mockResolvedValue(payload({ id: 3, owner_id: 2 }))
    await expect(app.updateResource(3, { owner_id: 2 })).resolves.toBe(true)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toEqual([{ id: 4 }])
    expect(planning.taskPlanning!.processes![1].tasks![0].resources).toEqual([{ id: 4 }])
  })
  it('changing process owner clears only assignments in that process', async () => {
    api.processIdPut.mockResolvedValue(payload({ id: 10, owner_id: 2 }))
    await expect(planning.updateProcessMeta(10, { owner_id: 2 })).resolves.toBe(true)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toEqual([])
    expect(planning.taskPlanning!.processes![1].tasks![0].resources).toEqual([{ id: 4 }])
  })
  it('unchanged resource owner and unrelated edits preserve assignments', async () => {
    api.resourcesIdPut.mockResolvedValue(payload({ id: 3, owner_id: 1 }))
    await app.updateResource(3, { owner_id: 1, title: 'Renamed' })
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toHaveLength(2)
    api.processIdPut.mockResolvedValue(payload({ id: 10 }))
    await planning.updateProcessMeta(10, { title: 'Renamed' })
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toHaveLength(2)
  })
  it('rejected ownership changes preserve assignments', async () => {
    api.resourcesIdPut.mockRejectedValue(new Error('403'))
    await expect(app.updateResource(3, { owner_id: 2 })).resolves.toBe(false)
    api.processIdPut.mockRejectedValue(new Error('403'))
    await expect(planning.updateProcessMeta(10, { owner_id: 2 })).resolves.toBe(false)
    expect(planning.taskPlanning!.processes![0].tasks![0].resources).toHaveLength(2)
  })
})


it('resource creation explicitly retains the caller as the default owner', async () => {
  useAuthStore().user = { id: 7, preset: 'worker' }
  api.resourcesPost.mockResolvedValue(payload({ id: 13, owner_id: 7 }))
  await expect(app.createResource({ code: 'Own', title: 'Own resource' })).resolves.toBe(true)
  expect(api.resourcesPost).toHaveBeenCalledWith({ code: 'Own', title: 'Own resource', owner_id: 7 })
})
