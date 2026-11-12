import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios'
import { beginMutation } from '@/offline/mutationGuard'

const fake = vi.hoisted(() => ({
  api: Object.fromEntries(['projectGet', 'resourcesGet', 'resourcesIdMembersGet', 'resourcesIdAbsenceGet', 'timesheetCalendarGet', 'userAllGet', 'userGet', 'userIdGet', 'userAccountsGet', 'userAccountsIdGet', 'userDaysGet', 'userIdDaysGet', 'timesheetStatesGet', 'planningProjectsGet', 'planningProcessesGet', 'planningTasksGet', 'permissionsMeGet', 'rbacPresetsGet', 'rbacPresetRulesGet', 'rbacMatrixGet', 'rbacPoliciesGet', 'rbacKindsGet', 'rbacUsersIdPermissionsGet', 'autoCreateConfigGet', 'taskIdCommentsGet', 'auditEventsGet'].map(name => [name, vi.fn()])) as Record<string, ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>>,
  hydrate: vi.fn(), warm: vi.fn(),
}))
vi.mock('@/api', async original => {
  const actual = await original<typeof import('@/api')>()
  const client = (methods: string[]) => class { constructor() { for (const method of methods) Object.assign(this, { [method]: (...args: unknown[]) => fake.api[method](...args) }) } }
  return { ...actual,
    ProjectsApi: client(['projectGet']), TimesheetResourcesApi: client(['resourcesGet', 'resourcesIdMembersGet', 'resourcesIdAbsenceGet']),
    TimesheetCalendarApi: client(['timesheetCalendarGet']), TimesheetStatesApi: client(['timesheetStatesGet']),
    UsersApi: client(['userAllGet', 'userGet', 'userIdGet', 'userAccountsGet', 'userAccountsIdGet', 'userDaysGet', 'userIdDaysGet']),
    PlanningApi: client(['planningProjectsGet', 'planningProcessesGet', 'planningTasksGet']),
    PermissionsApi: client(['permissionsMeGet']), RBACApi: client(['rbacPresetsGet', 'rbacPresetRulesGet', 'rbacMatrixGet', 'rbacPoliciesGet', 'rbacKindsGet', 'rbacUsersIdPermissionsGet']),
    AutoCreateApi: client(['autoCreateConfigGet']), TasksApi: client(['taskIdCommentsGet']), AuditApi: client(['auditEventsGet']),
  }
})
vi.mock('@/offline/hydrate', () => ({ apiPath: (path: string) => '/api/v1' + path, hydrateFromCache: fake.hydrate }))
vi.mock('@/offline/warmup', () => ({ scheduleWarmup: fake.warm }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'web', optionalStorage: true } }))
import { useAppStore, useAuthStore, usePlanningStore, useRbacStore, useTimesheetStore, useAuditStore } from './index'
import { invalidateApiReads } from './data/apiReads'
import { setAccessToken } from '@/token'
import { isOffline } from '@/offline/state'
import { legacyQueueAvailability } from '@/platform/state'
import { pendingRefs } from '@/offline/outbox'
const body = (data: unknown) => ({ data: { data } })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const forbidden = () => new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, { status: 403, statusText: 'Forbidden', headers: {}, config: { headers: new AxiosHeaders() }, data: { error: { message: 'Forbidden' } } } as AxiosResponse)
let pinia: ReturnType<typeof createPinia>
let values: Map<string, string>
beforeEach(() => {
  vi.resetAllMocks(); invalidateApiReads()
  values = new Map([['mvs_erp_user', JSON.stringify({ id: 1, preset: 'admin', username: 'fixture' })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout, clearTimeout })
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('indexedDB', { open: vi.fn(() => { throw new Error('IndexedDB forbidden') }) })
  fake.hydrate.mockRejectedValue(new Error('Legacy hydration must not run for ordinary web reads'))
  for (const api of Object.values(fake.api)) api.mockResolvedValue(body([]))
  fake.api.permissionsMeGet.mockResolvedValue(body([{ resource: 'project', action: 'view', scope: 'all' }]))
  fake.api.userGet.mockResolvedValue(body({ items: [{ id: 2, name: 'Employee' }], total: 1 }))
  fake.api.resourcesGet.mockResolvedValue(body({ items: [{ id: 8, code: 'R', owner_id: 1 }], total: 1 }))
  fake.api.projectGet.mockResolvedValue(body({ items: [{ id: 10, project_code: 'P' }], total: 1 }))
  fake.api.planningProjectsGet.mockResolvedValue(body({ projects: [{ id: 10, project_code: 'P' }] }))
  fake.api.planningProcessesGet.mockResolvedValue(body({ projects: [{ id: 10, processes: [{ id: 20 }] }] }))
  fake.api.planningTasksGet.mockResolvedValue(body({ processes: [{ id: 20, tasks: [{ id: 30, title: 'Task' }] }] }))
  fake.api.timesheetCalendarGet.mockResolvedValue(body({ resources: [{ resource_id: 8, periods: [] }] }))
  fake.api.userAccountsGet.mockResolvedValue(body({ items: [{ id: 2, username: 'account' }], total: 1 }))
  fake.api.userAccountsIdGet.mockResolvedValue(body({ id: 1001, username: 'beyond-first-page' }))
  fake.api.userIdGet.mockResolvedValue(body({ id: 1, last_name: 'Profile' }))
  fake.api.autoCreateConfigGet.mockResolvedValue(body({ enabled: true, processes: [] }))
  fake.api.auditEventsGet.mockResolvedValue(body({ items: [{ id: 'event' }], total: 1 }))
  fake.api.rbacUsersIdPermissionsGet.mockResolvedValue(body({ user_id: 2, overrides: [] }))
  pinia = createPinia(); setActivePinia(pinia); pendingRefs.value = new Set(); legacyQueueAvailability.value = 'empty'; isOffline.value = false
  setAccessToken('e30.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.fixture')
})
afterEach(() => { disposePinia(pinia); invalidateApiReads(); setAccessToken(null); vi.unstubAllGlobals() })

describe('web render-facing loaders with forbidden IndexedDB', () => {
  it.each([
    ['projects', async () => { const app = useAppStore(); await app.loadProjects(); expect(app.projects[0]?.id).toBe(10) }],
    ['resources', async () => { const app = useAppStore(); await app.loadResources(); expect(app.resources[0]?.id).toBe(8); expect(app.resourcesTotal).toBe(1) }],
    ['members', async () => { const app = useAppStore(); await app.loadResourceMembers(8); expect(app.resourceMembers[8]).toEqual([]) }],
    ['calendar', async () => { const app = useAppStore(); await app.loadCalendar(); expect(app.calendar[0]?.resource_id).toBe(8) }],
    ['people', async () => { fake.api.userAllGet.mockResolvedValue(body([{ id: 2 }])); const app = useAppStore(); await app.loadUsers(); expect(app.users[0]?.id).toBe(2) }],
    ['staff', async () => { const app = useAppStore(); await app.loadMyStaff(); expect(app.myStaff[0]?.id).toBe(2) }],
    ['employees and periods', async () => { const ts = useTimesheetStore(); await ts.loadEmployees(); expect(ts.employees[0]?.id).toBe(2); expect(fake.api.userDaysGet).toHaveBeenCalledOnce() }],
    ['day types', async () => { fake.api.timesheetStatesGet.mockResolvedValue(body([{ id: 9, code: 'leave' }])); const ts = useTimesheetStore(); await ts.loadStates(); expect(ts.states[0]?.id).toBe(9) }],
    ['project planning', async () => { const planning = usePlanningStore(); await planning.loadProjectPlanning(); expect(planning.projectPlanning?.projects?.[0]?.id).toBe(10) }],
    ['process planning', async () => { const planning = usePlanningStore(); await planning.loadProcessPlanning(); expect(planning.processPlanning?.projects?.[0]?.id).toBe(10) }],
    ['task planning', async () => { const planning = usePlanningStore(); await planning.loadTaskPlanning(); expect(planning.taskPlanning?.processes?.[0]?.tasks?.[0]?.id).toBe(30) }],
    ['permissions', async () => { const rbac = useRbacStore(); expect(await rbac.loadMyPermissions()).toBe(true); expect(rbac.can('project', 'view')).toBe(true) }],
    ['accounts', async () => { const app = useAppStore(); await app.loadAdminUsers(); expect(app.adminUsers[0]?.id).toBe(2) }],
    ['account detail', async () => { expect((await useAppStore().loadAdminUser(1001))?.id).toBe(1001); expect(fake.api.userAccountsGet).not.toHaveBeenCalled() }],
    ['profile', async () => { const auth = useAuthStore(); expect(await auth.loadProfile(1)).toBe(true); expect(auth.user?.last_name).toBe('Profile') }],
    ['template', async () => { const app = useAppStore(); await app.loadAutoCreateConfig(); expect(app.autoCreateConfig?.enabled).toBe(true) }],
    ['role configuration', async () => { const rbac = useRbacStore(); expect(await rbac.loadRbac()).toBe(true); expect(fake.api.rbacKindsGet).toHaveBeenCalledOnce() }],
    ['individual permissions', async () => { const rbac = useRbacStore(); expect(await rbac.loadUserPermissions(2)).toBe(true); expect(rbac.userPermissions?.user_id).toBe(2) }],
    ['comments', async () => { fake.api.taskIdCommentsGet.mockResolvedValue(body([{ id: 90, content: 'Comment' }])); const planning = usePlanningStore(); await planning.loadTaskComments(30); expect(planning.commentsByTask[30]?.[0]?.id).toBe(90) }],
    ['audit', async () => { const audit = useAuditStore(); expect(await audit.load({ offset: 50, search: 'query' })).toBe(true); expect(audit.items).toHaveLength(1); expect(fake.api.auditEventsGet.mock.calls[0][1]).toBe(50) }],
  ] as const)('loads %s from the API, without local hydration', async (_, load) => {
    await load()
    expect(fake.hydrate).not.toHaveBeenCalled()
    expect(indexedDB.open).not.toHaveBeenCalled()
  })
  it('caches a successful empty list without hiding a failed load as empty success', async () => {
    const app = useAppStore()
    fake.api.userAllGet.mockResolvedValue(body([]))
    await app.loadUsers(); await app.loadUsers()
    expect(fake.api.userAllGet).toHaveBeenCalledOnce()
    invalidateApiReads(); fake.api.userAllGet.mockRejectedValueOnce(new Error('network failed'))
    await app.loadUsers()
    expect(app.usersError).toBe('network failed')
    expect(app.usersLoading).toBe(false)
  })
  it('retains a usable snapshot and explicit error on network failure, then recovers', async () => {
    const app = useAppStore(); await app.loadProjects()
    fake.api.projectGet.mockRejectedValueOnce(new Error('network failed'))
    await app.refreshProjects()
    expect(app.projects).toHaveLength(1); expect(app.projectsError).toBe('network failed')
    await app.refreshProjects()
    expect(app.projectsError).toBeNull(); expect(app.projectsLoading).toBe(false)
  })
  it('does not grant permissions from a persisted previous snapshot when the API denies them', async () => {
    values.set('mvs_erp_perms_1', JSON.stringify([{ resource: 'project', action: 'view', scope: 'all' }]))
    fake.api.permissionsMeGet.mockResolvedValue(body([]))
    const rbac = useRbacStore()
    expect(await rbac.loadMyPermissions()).toBe(true)
    expect(rbac.can('project', 'view')).toBe(false)
    expect(rbac.permsLoaded).toBe(true)
  })
  it('does not reuse another account payload or apply a late previous-account response', async () => {
    const app = useAppStore(), gate = deferred<ReturnType<typeof body>>()
    app.adminUsers = [{ id: 2 }]; app.calendar = [{ resource_id: 8 }]; app.projects = [{ id: 10 }]
    fake.api.resourcesGet.mockReturnValueOnce(gate.promise)
    const pending = app.refreshResources()
    app.resetUserData(); gate.resolve(body({ items: [{ id: 99 }], total: 1 })); await pending
    expect(app.adminUsers).toEqual([]); expect(app.projects).toEqual([]); expect(app.calendar).toEqual([]); expect(app.resources).toEqual([])
    expect(app.resourcesError).toBeNull()
  })
  it('clears protected read models when the backend changes the current permission scope', async () => {
    const rbac = useRbacStore(); await rbac.refreshPermissions()
    const app = useAppStore(); app.resources = [{ id: 8 }]; app.projects = [{ id: 10 }]
    usePlanningStore().taskPlanning = { processes: [{ id: 20 }] }
    fake.api.permissionsMeGet.mockResolvedValue(body([{ resource: 'project', action: 'view', scope: 'self' }]))
    expect(await rbac.refreshPermissions()).toBe(true)
    expect(app.resources).toEqual([]); expect(app.projects).toEqual([]); expect(usePlanningStore().taskPlanning).toBeNull()
  })
  it('does not replace an optimistic resource edit with a GET received during the write', async () => {
    const app = useAppStore(); app.resources = [{ id: 8, code: 'local edit' }]
    const gate = deferred<ReturnType<typeof body>>()
    fake.api.resourcesGet.mockReturnValueOnce(gate.promise)
    const pending = app.refreshResources(); const finish = beginMutation()
    gate.resolve(body({ items: [{ id: 8, code: 'old server' }], total: 1 })); await pending; finish()
    expect(app.resources[0]?.code).toBe('local edit'); expect(app.resourcesError).toBeNull()
  })
  it('keeps only the latest administrative search and its loading state', async () => {
    const app = useAppStore(), old = deferred<ReturnType<typeof body>>(), recent = deferred<ReturnType<typeof body>>()
    fake.api.userAccountsGet.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise)
    const first = app.refreshAdminUsers('old'), second = app.refreshAdminUsers('recent')
    await first; expect(app.adminUsersLoading).toBe(true)
    recent.resolve(body({ items: [{ id: 3 }], total: 1 })); await second
    old.resolve(body({ items: [{ id: 2 }], total: 1 }))
    expect(app.adminUsers.map(x => x.id)).toEqual([3]); expect(app.adminUsersError).toBeNull(); expect(app.adminUsersLoading).toBe(false)
  })
  it('clears forbidden resource rows instead of continuing to display a cached roster', async () => {
    const app = useAppStore(); await app.loadResources()
    fake.api.resourcesGet.mockRejectedValueOnce(forbidden())
    await app.refreshResources()
    expect(app.resources).toEqual([]); expect(app.resourcesTotal).toBe(0); expect(app.resourcesError).toBe('Forbidden')
  })
  it('keeps resources already paged in while requesting the next exact offset', async () => {
    const app = useAppStore()
    fake.api.resourcesGet.mockResolvedValueOnce(body({ items: [{ id: 8 }], total: 2 })).mockResolvedValueOnce(body({ items: [{ id: 9 }], total: 2 }))
    await app.loadResources(); expect(await app.loadMoreResources()).toBe(true)
    expect(fake.api.resourcesGet.mock.calls[1][2]).toBe(1)
    expect(app.resources.map(x => x.id)).toEqual([8, 9]); expect(app.resourcesHasMore).toBe(false)
  })
  it('does not let consumers mutate the operative API snapshot', async () => {
    fake.api.userAllGet.mockResolvedValue(body([{ id: 2, last_name: 'Original' }]))
    const app = useAppStore(); await app.loadUsers(); app.users[0].last_name = 'Changed locally'; app.users = []
    await app.loadUsers()
    expect(app.users[0].last_name).toBe('Original'); expect(fake.api.userAllGet).toHaveBeenCalledOnce()
  })
  it('does not fallback to per-employee requests after a forbidden batch', async () => {
    const ts = useTimesheetStore(); ts.employees = [{ id: 2 }]
    fake.api.userDaysGet.mockRejectedValueOnce(forbidden())
    expect(await ts.refreshPeriods('2026-11-01', '2026-11-30')).toBe(false)
    expect(fake.api.userIdDaysGet).not.toHaveBeenCalled(); expect(ts.error).toBe('Forbidden')
  })
  it('preserves compatibility with a backend missing the batch endpoint', async () => {
    const ts = useTimesheetStore(); ts.employees = [{ id: 2 }]
    fake.api.userDaysGet.mockRejectedValueOnce(new AxiosError('missing', undefined, undefined, undefined, { status: 404 } as AxiosResponse))
    fake.api.userIdDaysGet.mockResolvedValue(body([{ id: 4, start_date: '2026-11-02', end_date: '2026-11-03' }]))
    expect(await ts.refreshPeriods('2026-11-01', '2026-11-30')).toBe(true)
    expect(ts.periodsByEmployee[2]?.[0]?.id).toBe(4)
  })
  it('does not merge an obsolete timesheet window over the latest one', async () => {
    const ts = useTimesheetStore(); ts.employees = [{ id: 2 }]
    const old = deferred<ReturnType<typeof body>>()
    fake.api.userDaysGet.mockReturnValueOnce(old.promise).mockResolvedValueOnce(body([{ user_id: 2, days: [{ id: 5, start_date: '2026-11-02', end_date: '2026-11-03' }] }]))
    const first = ts.refreshPeriods('2026-11-01', '2026-11-20')
    expect(await ts.refreshPeriods('2026-11-01', '2026-11-30')).toBe(true)
    expect(await first).toBe(false); old.resolve(body([{ user_id: 2, days: [] }]))
    expect(ts.periodsByEmployee[2]?.[0]?.id).toBe(5)
  })
})

it('does not apply a fast cache hit after its account has already been reset', async () => {
  const app = useAppStore(); fake.api.userAllGet.mockResolvedValue(body([{ id: 2, username: 'previous' }]))
  await app.loadUsers(); app.users = []
  const pending = app.loadUsers()
  values.set('mvs_erp_user', JSON.stringify({ id: 9, username: 'next' })); app.resetUserData()
  await pending
  expect(app.users).toEqual([]); expect(app.usersError).toBeNull()
})
it('keeps create-only resource access usable without issuing a forbidden listing', async () => {
  const rbac = useRbacStore(); rbac.permsLoaded = true
  rbac.myPermissions = [{ resource: 'resource', action: 'create', scope: 'self' }]
  const app = useAppStore(); await app.loadResources()
  expect(fake.api.resourcesGet).not.toHaveBeenCalled()
  expect(app.resources).toEqual([]); expect(app.resourcesError).toBeNull(); expect(app.resourcesLoading).toBe(false)
})
it('tries the web profile API despite a stale offline hint', async () => {
  isOffline.value = true
  expect(await useAuthStore().fetchProfile(1)).toBe(true)
  expect(fake.api.userIdGet).toHaveBeenCalledOnce()
})

it('updates action rights without blanking a visible table whose view scope is unchanged', async () => {
  const rbac = useRbacStore()
  fake.api.permissionsMeGet.mockResolvedValueOnce(body([{ resource: 'user_admin', action: 'view', scope: 'all' }]))
  await rbac.refreshPermissions(); const revision = rbac.viewRevision
  const app = useAppStore(); app.adminUsers = [{ id: 2 }]
  fake.api.permissionsMeGet.mockResolvedValueOnce(body([{ resource: 'user_admin', action: 'view', scope: 'all' }, { resource: 'user_admin', action: 'update', scope: 'all' }]))
  await rbac.refreshPermissions()
  expect(app.adminUsers.map(user => user.id)).toEqual([2])
  expect(rbac.can('user_admin', 'update')).toBe(true)
  expect(rbac.viewRevision).toBe(revision)
})
it('does not clear read models just because equivalent permissions arrived in another order', async () => {
  const rbac = useRbacStore(), rules = [{ resource: 'user_admin', action: 'view', scope: 'all' }, { resource: 'resource', action: 'view', scope: 'self' }]
  fake.api.permissionsMeGet.mockResolvedValueOnce(body(rules)); await rbac.refreshPermissions()
  const app = useAppStore(); app.resources = [{ id: 8 }]
  fake.api.permissionsMeGet.mockResolvedValueOnce(body([...rules].reverse())); await rbac.refreshPermissions()
  expect(app.resources).toHaveLength(1)
})
it('keeps a worker-only timesheet usable without requesting a forbidden day-type catalogue', async () => {
  const rbac = useRbacStore(); rbac.permsLoaded = true; rbac.myPermissions = [{ resource: 'worker', action: 'view', scope: 'self' }]
  const ts = useTimesheetStore(); await ts.loadStates(); await ts.loadEmployees()
  expect(fake.api.timesheetStatesGet).not.toHaveBeenCalled()
  expect(ts.employees).toHaveLength(1); expect(ts.error).toBeNull()
})
