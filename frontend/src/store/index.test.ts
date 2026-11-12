/**
 * Pure-logic unit tests for the store's list-merge semantics introduced by
 * commit 02cd232 ("fix(store): merge paged lists on background pull instead of
 * truncating").
 *
 * mergeResourceLists / mergeEmployeeLists / sameResources / sameEmployees are
 * private to the store setups, so the tests drive them through the public
 * surface: refreshResources (TimesheetResourcesApi) and refreshEmployees
 * (UsersApi), with the generated API client replaced by class-shaped mocks
 * (vitest mocks passed to `new` must be real classes for the constructor
 * semantics to hold). What is asserted is the observable contract of the fix:
 *  - dedup by id — one row per id;
 *  - fresh page wins for a repeated id (a later fetch of the same row);
 *  - already-loaded extra pages are preserved (a background pull of page 0
 *    must not truncate pages loaded via "load more");
 *  - the ORDER of existing entries is stable (current precedes fresh-only);
 *  - the ARRAY IDENTITY is preserved when the merged roster equals the current
 *    one (sameResources/sameEmployees), so dependents do not re-render;
 *  - empty page input keeps the current list untouched;
 *  - id-less rows are dropped (they cannot be deduplicated).
 *
 * The auth-store section checks the real token.expiry decoding contract that
 * drives the proactive-refresh margin (accessExpired check).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { resetWebCommands } from './data/webCommands'
import { useAppStore, useTimesheetStore, useAuthStore, useRbacStore } from './index'
import { buildPullSteps } from '../offline/warmup'
import { reloadDomainsFor } from '../offline/sync'
import { getAccessToken, setAccessToken } from '@/token'
import type { DtoUserInfo } from '@/api'

/** Mutable per-test method implementations for the mocked API classes. */
const api = vi.hoisted(() => ({
  resourcesGet: vi.fn(),
  userGet: vi.fn(),
  userAccountsGet: vi.fn(),
  rbacUsersIdPermissionsGet: vi.fn(),
  rbacUsersIdPermissionsPut: vi.fn(),
}))

vi.mock('@/api', () => {
  class TimesheetResourcesApi {
    resourcesGet(...args: unknown[]) {
      return api.resourcesGet(...args)
    }
  }
  class UsersApi {
    userAccountsGet(...args: unknown[]) { return api.userAccountsGet(...args) }
    userGet(...args: unknown[]) {
      return api.userGet(...args)
    }
  }
  class Configuration {
    constructor(opts?: unknown) {
      Object.assign(this, opts ?? {})
    }
  }
  return {
    AuthApi: class {},
    ProjectsApi: class {},
    ProcessesApi: class {},
    TasksApi: class {},
    TimesheetResourcesApi,
    TimesheetCalendarApi: class {},
    TimesheetStatesApi: class {},
    PlanningApi: class {},
    MilestonesApi: class {},
    UsersApi,
    AssignmentsApi: class {},
    AutoCreateApi: class {},
    RBACApi: class {
      rbacUsersIdPermissionsGet(...args: unknown[]) { return api.rbacUsersIdPermissionsGet(...args) }
      rbacUsersIdPermissionsPut(...args: unknown[]) { return api.rbacUsersIdPermissionsPut(...args) }
    },
    PermissionsApi: class {},
    AuditApi: class {},
    Configuration,
  }
})

interface ResourceLike {
  id?: number
  code?: string
  title?: string
  employees_count?: number
}

interface EmployeeLike {
  id?: number
  name?: string
  position?: string
  manager_id?: number | null
  preset?: string
  hire_date?: string | null
  termination_date?: string | null
}

/** Points the mocked resources API at one page response. */
function pageResources(items: ResourceLike[], total: number): void {
  api.resourcesGet.mockResolvedValue({ data: { data: { items, total } } })
}

/** Points the mocked users API at one page response. */
function pageEmployees(items: EmployeeLike[], total: number): void {
  api.userGet.mockResolvedValue({ data: { data: { items, total } } })
}

let appStore: ReturnType<typeof useAppStore>
let tsStore: ReturnType<typeof useTimesheetStore>

beforeEach(() => {
  resetWebCommands()
  setActivePinia(createPinia())
  appStore = useAppStore()
  tsStore = useTimesheetStore()
  vi.clearAllMocks()
})

describe('mergeResourceLists / sameResources (via refreshResources)', () => {
  it('dedups by id, fresh page wins, existing order preserved, fresh-only appended last', async () => {
    appStore.resources = [
      { id: 1, code: 'R1', title: 'старое' },
      { id: 2, code: 'R2', title: 'Второй' },
    ]
    // Page 0 again — the same id 1 with a NEW title, plus a brand-new id 3.
    pageResources(
      [
        { id: 1, code: 'R1', title: 'новое' },
        { id: 3, code: 'R3', title: 'Третий' },
      ],
      3,
    )

    await appStore.refreshResources()

    const ids = appStore.resources.map((r) => r.id)
    expect(ids).toEqual([1, 2, 3])
    expect(appStore.resources[0]?.title).toBe('новое')
    expect(appStore.resourcesTotal).toBe(3)
  })

  it('keeps already-loaded extra pages when the fresh page only re-covers the first page', async () => {
    // Three rows already loaded via "load more" (pages 0+50+100).
    appStore.resources = [
      { id: 1, code: 'R1', title: 'Один' },
      { id: 2, code: 'R2', title: 'Два' },
      { id: 3, code: 'R3', title: 'Три' },
    ]
    // A background pull of page 0 alone must NOT drop ids 2/3.
    pageResources([{ id: 1, code: 'R1', title: 'Один (свежий)' }], 3)

    await appStore.refreshResources()

    expect(appStore.resources.map((r) => r.id)).toEqual([1, 2, 3])
    expect(appStore.resources[0]?.title).toBe('Один (свежий)')
  })

  it('preserves the array identity when the merged result equals the current one', async () => {
    appStore.resources = [
      { id: 1, code: 'R1', title: 'Один' },
      { id: 2, code: 'R2', title: 'Два' },
    ]
    pageResources(
      [
        { id: 1, code: 'R1', title: 'Один' },
        { id: 2, code: 'R2', title: 'Два' },
      ],
      2,
    )

    const before = appStore.resources
    await appStore.refreshResources()

    // sameResources() → the reference is kept stable (no re-render of dependents).
    expect(appStore.resources).toBe(before)
  })

  it('replaces the array when a field actually changed', async () => {
    appStore.resources = [{ id: 1, code: 'R1', title: 'Один' }]
    pageResources([{ id: 1, code: 'R1', title: 'Один-обновлён' }], 1)

    const before = appStore.resources
    await appStore.refreshResources()

    expect(appStore.resources).not.toBe(before)
    expect(appStore.resources[0]?.title).toBe('Один-обновлён')
  })

  it('returns an empty page without touching the current list (identity stable)', async () => {
    appStore.resources = [{ id: 1, code: 'R1', title: 'Один' }]
    pageResources([], 0)

    const before = appStore.resources
    await appStore.refreshResources()

    expect(appStore.resources).toBe(before)
    expect(appStore.resources).toHaveLength(1)
    expect(appStore.resourcesTotal).toBe(0)
  })

  it('drops rows without an id from the merged result', async () => {
    appStore.resources = [{ id: 1, code: 'R1', title: 'Один' }]
    pageResources(
      [
        { id: 2, code: 'R2', title: 'Два' },
        { code: 'NO-ID', title: 'Без id' },
      ],
      2,
    )

    await appStore.refreshResources()

    expect(appStore.resources.map((r) => r.id)).toEqual([1, 2])
  })
})

/**
 * The loading/error flags drive the "Загрузка…" line and the error line of the
 * Resources page. A background pull (the 60-second PULL cycle, the members
 * step) must not touch them — otherwise the page repaints its status line over
 * an already rendered table on every cycle.
 */
describe('refreshResources: silent background mode', () => {
  it('a silent refresh leaves the loading and error flags untouched', async () => {
    pageResources([{ id: 1, code: 'R1', title: 'Один' }], 1)
    appStore.resourcesError = 'прошлая ошибка'

    await appStore.refreshResources(true)

    expect(appStore.resourcesLoading).toBe(false)
    expect(appStore.resourcesError).toBe('прошлая ошибка')
  })

  it('a silent refresh still applies the data', async () => {
    appStore.resources = [{ id: 1, code: 'R1', title: 'Один' }]
    pageResources([{ id: 1, code: 'R1', title: 'Один (свежий)' }], 1)

    await appStore.refreshResources(true)

    expect(appStore.resources[0]?.title).toBe('Один (свежий)')
  })

  it('a silent failure records nothing (no error line over a good table)', async () => {
    api.resourcesGet.mockRejectedValue(new Error('boom'))

    await appStore.refreshResources(true)

    expect(appStore.resourcesError).toBeNull()
    expect(appStore.resourcesLoading).toBe(false)
  })

  it('a loud refresh raises the flags and clears the previous error', async () => {
    pageResources([], 0)
    appStore.resourcesError = 'прошлая ошибка'

    const pending = appStore.refreshResources()
    expect(appStore.resourcesLoading).toBe(true)

    await pending

    expect(appStore.resourcesLoading).toBe(false)
    expect(appStore.resourcesError).toBeNull()
  })

  it('a loud failure lands in the error flag', async () => {
    api.resourcesGet.mockRejectedValue(new Error('boom'))

    await appStore.refreshResources()

    expect(appStore.resourcesError).toBe('boom')
    expect(appStore.resourcesLoading).toBe(false)
  })
})

describe('mergeEmployeeLists / sameEmployees (via refreshEmployees)', () => {
  it('dedups the roster by id, fresh wins, extras preserved, order stable', async () => {
    tsStore.employees = [
      { id: 1, name: 'Анна', position: 'Инженер', manager_id: undefined, preset: 'worker' },
      { id: 2, name: 'Борис', position: 'Директор', manager_id: undefined, preset: 'admin' },
    ]
    pageEmployees(
      [
        {
          id: 2,
          name: 'Борис',
          position: 'Директор',
          manager_id: null,
          preset: 'admin',
          hire_date: '2020-01-01',
          termination_date: null,
        },
        { id: 3, name: 'Виктор', position: 'Менеджер', manager_id: 2, preset: 'manager' },
      ],
      3,
    )

    await tsStore.refreshEmployees()

    const ids = tsStore.employees.map((e) => e.id)
    expect(ids).toEqual([1, 2, 3])
    // The fresh page overwrote id 2 (hire_date came from the fresh page).
    expect(tsStore.employees[1]?.hire_date).toBe('2020-01-01')
    expect(tsStore.employeesTotal).toBe(3)
  })

  it('preserves the employees array identity for equal snapshots (grid no flicker)', async () => {
    tsStore.employees = [{ id: 1, name: 'Анна', position: 'Инженер', manager_id: undefined, preset: 'worker' }]
    pageEmployees([{ id: 1, name: 'Анна', position: 'Инженер', manager_id: undefined, preset: 'worker' }], 1)

    const before = tsStore.employees
    await tsStore.refreshEmployees()

    expect(tsStore.employees).toBe(before)
  })

  it('keeps a load-more-extended roster when the background pull returns just page 0', async () => {
    tsStore.employees = [
      { id: 1, name: 'Анна', position: 'Инженер', manager_id: undefined, preset: 'worker' },
      { id: 2, name: 'Борис', position: 'Директор', manager_id: undefined, preset: 'admin' },
    ]
    pageEmployees([{ id: 1, name: 'Анна', position: 'Инженер', manager_id: undefined, preset: 'worker' }], 2)

    await tsStore.refreshEmployees()

    expect(tsStore.employees).toHaveLength(2)
    expect(tsStore.employees[1]?.id).toBe(2)
  })
})

describe('auth access-expiry decoding (a token-margin contract)', () => {
  // The auth store subscribes to the cross-tab session channel at creation,
  // which touches window/document — provide inert stubs for the node env.
  beforeAll(() => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  const jwt = (expSec: number): string => {
    // btoa is the app's own base64url encoder input (see base64UrlDecode in
    // store/index.ts) — node provides the global.
    const b64 = btoa(JSON.stringify({ exp: expSec }))
    const payload = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `h.${payload}.s`
  }

  beforeEach(() => setAccessToken(null))

  it('reports the token expired when missing', () => {
    expect(useAuthStore().accessExpired()).toBe(true)
  })

  it('reports the token expired when exp has passed', () => {
    setAccessToken(jwt(Math.floor(Date.now() / 1000) - 60))
    expect(useAuthStore().accessExpired()).toBe(true)
  })

  it('reports a valid (far-future exp) token as not expired', () => {
    setAccessToken(jwt(Math.floor(Date.now() / 1000) + 3600))
    expect(useAuthStore().accessExpired()).toBe(false)
  })

  it('treats an unparseable token as expired', () => {
    setAccessToken('not-a-jwt')
    expect(useAuthStore().accessExpired()).toBe(true)
  })

  it('stops reporting expiry after a saved session restores a valid token', () => {
    const auth = useAuthStore()
    expect(auth.accessExpired()).toBe(true)
    setAccessToken(jwt(Math.floor(Date.now() / 1000) + 3600))
    expect(auth.accessExpired()).toBe(false)
  })

  it('detects expiry as time passes without replacing the token', () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      setAccessToken(jwt(Math.floor(now / 1000) + 60))
      const auth = useAuthStore()
      expect(auth.accessExpired()).toBe(false)
      clock.mockReturnValue(now + 61_000)
      expect(auth.accessExpired()).toBe(true)
    } finally { clock.mockRestore() }
  })

  it('detects a removed token after previously observing a valid one', () => {
    setAccessToken(jwt(Math.floor(Date.now() / 1000) + 3600))
    const auth = useAuthStore()
    expect(auth.accessExpired()).toBe(false)
    setAccessToken(null)
    expect(auth.accessExpired()).toBe(true)
  })

  it('round-trips through the in-memory token store', () => {
    expect(getAccessToken()).toBe('')
    setAccessToken('abc.def.ghi')
    expect(getAccessToken()).toBe('abc.def.ghi')
  })
})

describe('reloadDomainsFor — the entity → affected-domains map (online post-mutation refresh)', () => {
  // reloadDomainsFor instantiates the stores at call time; the auth store
  // touches window/document on creation (cross-tab session channel).
  beforeAll(() => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    // The roster-family reloads are gated by "sees the roster" — give the
    // auth store an admin preset so the fallback path admits them.
    useAuthStore().user = { preset: 'admin' } satisfies DtoUserInfo
  })

  it('maps a project mutation to every planning aggregate + the CRUD project list', () => {
    const names = reloadDomainsFor('project').map((r) => r.name).sort()
    expect(names).toEqual(['process-plan', 'project-plan', 'projects', 'task-plan'])
  })

  it('maps a process mutation to the process/task/project aggregates', () => {
    const names = reloadDomainsFor('process').map((r) => r.name).sort()
    expect(names).toEqual(['process-plan', 'project-plan', 'task-plan'])
  })

  it('maps task/milestone/assignment mutations to task-plan only', () => {
    for (const e of ['task', 'milestone', 'assignment'] as const) {
      expect(reloadDomainsFor(e).map((r) => r.name)).toEqual(['task-plan'])
    }
  })

  it('maps user mutations to the roster + name catalogs', () => {
    const names = reloadDomainsFor('user').map((r) => r.name).sort()
    expect(names).toEqual(['employees', 'myStaff', 'users'])
  })

  it('keeps the roster-family reloads for timesheet entities', () => {
    // The periods reloader is only emitted once a window is initialized
    // (ts.windowStart) — simulate a timesheet page that has been opened.
    const tsStore = useTimesheetStore()
    tsStore.windowStart = '2025-01-01'
    tsStore.windowEnd = '2025-12-31'
    const names = reloadDomainsFor('period').map((r) => r.name)
    expect(names).toContain('employees')
    expect(names).toContain('periods')
    expect(names).toContain('calendar')
  })
})

it('explicit none scopes never enable resource navigation or actions', () => {
  const rbac = useRbacStore()
  rbac.myPermissions = ['view', 'create', 'update', 'delete'].map((action) => ({ resource: 'resource', action, scope: 'none' }))
  for (const action of ['view', 'create', 'update', 'delete']) expect(rbac.can('resource', action)).toBe(false)
})

describe('RBAC peer probes reach the scope evaluator', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    useAuthStore().user = { id: 7, preset: 'worker' }
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['sib', 'sib_project'])('uses the supplied %s probe and denies missing evidence', (scope) => {
    const rbac = useRbacStore()
    rbac.myPermissions = [{ resource: 'task', action: 'update', scope }]
    expect(rbac.canOwn('task', 'update', { processOwner: 7, projectOwner: 7 })).toBe(false)
    expect(rbac.canOwn('task', 'update', {}, { sibling: scope === 'sib', projectSibling: scope === 'sib_project' })).toBe(true)
    expect(rbac.canOwn('task', 'delete', {}, { sibling: true, projectSibling: true })).toBe(false)
  })
})


describe('individual permission snapshots', () => {
  const snapshot = (id: number, scope = 'self') => ({
    user_id: id, preset: 'worker', overrides: [{ resource: 'resource', action: 'view', scope, granted: true }],
  })
  const response = (id: number, scope = 'self') => ({ data: { data: snapshot(id, scope) } })
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }
  beforeEach(() => {
    api.rbacUsersIdPermissionsGet.mockReset()
    api.rbacUsersIdPermissionsPut.mockReset()
  })
  it('retains the same employee snapshot during a refresh', async () => {
    const store = useRbacStore()
    store.userPermissions = snapshot(5)
    const get = deferred<ReturnType<typeof response>>()
    api.rbacUsersIdPermissionsGet.mockReturnValueOnce(get.promise)
    const loading = store.loadUserPermissions(5)
    expect(store.userPermissions).toEqual(snapshot(5))
    expect(store.userPermissionsLoading).toBe(true)
    get.resolve(response(5, 'all'))
    expect(await loading).toBe(true)
    expect(store.userPermissions).toEqual(snapshot(5, 'all'))
  })
  it('conceals another employee snapshot and rejects a late old read', async () => {
    const store = useRbacStore()
    store.userPermissions = snapshot(5)
    const old = deferred<ReturnType<typeof response>>()
    const recent = deferred<ReturnType<typeof response>>()
    api.rbacUsersIdPermissionsGet.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise)
    const first = store.loadUserPermissions(5)
    const second = store.loadUserPermissions(6)
    expect(store.userPermissions).toBeNull()
    recent.resolve(response(6))
    expect(await second).toBe(true)
    old.resolve(response(5, 'all'))
    expect(await first).toBe(false)
    expect(store.userPermissions?.user_id).toBe(6)
  })
  it('a confirmed save wins over an older GET and updates the saved baseline', async () => {
    const store = useRbacStore()
    store.userPermissions = snapshot(5)
    const get = deferred<ReturnType<typeof response>>()
    api.rbacUsersIdPermissionsGet.mockReturnValueOnce(get.promise)
    const loading = store.loadUserPermissions(5)
    api.rbacUsersIdPermissionsPut.mockResolvedValueOnce({})
    const overrides = snapshot(5, 'all').overrides
    expect(await store.saveUserPermissions(5, overrides)).toBe(true)
    get.resolve(response(5))
    expect(await loading).toBe(false)
    expect(store.userPermissions?.overrides).toEqual(overrides)
    expect(store.userPermissionsLoading).toBe(false)
  })
  it('a failed save leaves confirmed permissions intact', async () => {
    const store = useRbacStore()
    store.userPermissions = snapshot(5)
    api.rbacUsersIdPermissionsPut.mockRejectedValueOnce(new Error('save rejected'))
    expect(await store.saveUserPermissions(5, snapshot(5, 'all').overrides)).toBe(false)
    expect(store.userPermissions).toEqual(snapshot(5))
  })
  it('a failed refresh retains permissions already confirmed by the server', async () => {
    const store = useRbacStore()
    store.userPermissions = snapshot(5)
    api.rbacUsersIdPermissionsPut.mockResolvedValueOnce({})
    expect(await store.saveUserPermissions(5, snapshot(5, 'all').overrides)).toBe(true)
    api.rbacUsersIdPermissionsGet.mockRejectedValueOnce(new Error('refresh failed'))
    expect(await store.loadUserPermissions(5)).toBe(false)
    expect(store.userPermissions?.overrides).toEqual(snapshot(5, 'all').overrides)
    expect(store.userPermissionsLoading).toBe(false)
  })
  it('saving a previously opened employee does not cancel the current employee read', async () => {
    const store = useRbacStore()
    store.userPermissions = snapshot(5)
    const put = deferred<unknown>()
    const get = deferred<ReturnType<typeof response>>()
    api.rbacUsersIdPermissionsPut.mockReturnValueOnce(put.promise)
    const saving = store.saveUserPermissions(5, [])
    api.rbacUsersIdPermissionsGet.mockReturnValueOnce(get.promise)
    const loading = store.loadUserPermissions(6)
    put.resolve({})
    expect(await saving).toBe(true)
    expect(store.userPermissionsLoading).toBe(true)
    get.resolve(response(6))
    expect(await loading).toBe(true)
    expect(store.userPermissions?.user_id).toBe(6)
  })
  it.each([true, false])('a previous employee save does not alter current load errors (success=%s)', async (success) => {
    const store = useRbacStore()
    store.userPermissions = snapshot(6)
    store.userPermissionsError = 'Current employee refresh failed'
    if (success) api.rbacUsersIdPermissionsPut.mockResolvedValueOnce({})
    else api.rbacUsersIdPermissionsPut.mockRejectedValueOnce(new Error('Previous employee save failed'))
    expect(await store.saveUserPermissions(5, [])).toBe(success)
    expect(store.userPermissionsError).toBe('Current employee refresh failed')
    expect(store.userPermissions?.user_id).toBe(6)
  })

})


describe('dictionary administration without employee-calendar access', () => {
  beforeAll(() => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })
  afterAll(() => vi.unstubAllGlobals())
  beforeEach(() => { useAuthStore().user = { id: 42, preset: 'worker' } })
  it('refreshes dictionary changes without loading employees or their periods', () => {
    const rbac = useRbacStore()
    rbac.permsLoaded = true
    rbac.myPermissions = [{ resource: 'state', action: 'view', scope: 'all' }]
    expect(reloadDomainsFor('state').map((domain) => domain.name)).toEqual(['states'])
    expect(reloadDomainsFor('period')).toEqual([])
    const names = buildPullSteps().map((step) => step.name)
    expect(names).toContain('states')
    expect(names).not.toContain('employees')
    expect(names).not.toContain('periods')
  })
  it('employee-calendar access alone never refreshes a forbidden dictionary', () => {
    const rbac = useRbacStore()
    rbac.permsLoaded = true
    rbac.myPermissions = [{ resource: 'worker', action: 'view', scope: 'all' }]
    expect(reloadDomainsFor('state')).toEqual([])
    expect(buildPullSteps().map((step) => step.name)).not.toContain('states')
  })
})
