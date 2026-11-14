import type {
  DtoAssignmentResponse,
  DtoDetailedProcess,
  DtoDetailedProject,
  DtoDetailedTask,
  DtoMilestone,
  DtoProcess,
  DtoProjectPlanning,
  DtoProjectResponse,
  DtoResourceMemberResponse,
  DtoResourceCalendar,
  DtoResourceAbsenceResponse,
  DtoUserStatesResponse,
  DtoResourceResponse,
  DtoStateResponse,
  DtoTaskPlanning,
  DtoUserResponse,
  DtoUserStateResponse,
} from '@/api'
import { updatePeriodAvailability } from './periodAvailability'
import { replaceEmployeeAbsences, applyRangeSplit, type PutPeriodFields } from './timesheet'
import { addResourceAssignment } from './planning'

export interface ProjectionEntry {
  method: string
  url: string
  body?: unknown
  entity: string
  tempId?: number
  ts: number
}
export interface ProjectionCache {
  keys(): Promise<string[]>
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

export function createCacheApplier(cache: ProjectionCache) {
  const idbKeys = (_store: string) => cache.keys()
  const idbGet = <T>(_store: string, key: string) => cache.get<T>(key)
  const idbPut = (_store: string, key: string, value: unknown) => cache.put(key, value)
  const stripUserPrefix = (key: string) => key.replace(/^u\d+:/, '')

const CACHE_STORE = 'cache'

interface CachedBody {
  data?: unknown
  error?: unknown
}

interface CachedEntryLike {
  ts: number
  data: CachedBody
}

/** A listing stored in the cache: { items, total } */
interface ListPayload<T> {
  items: T[]
  total?: number
}

/**
 * Fields of offline mutation bodies (ProjectionEntry.body) read by the write-through.
 * All optional — only the fields this module consumes are declared.
 */
interface MutationBody {
  code?: string
  title?: string
  name?: string
  preset?: string
  position?: string
  manager_id?: number
  hire_date?: string
  termination_date?: string
  username?: string
  owner_id?: number
  start_date?: string
  end_date?: string
  date?: string
  priority?: number
  project_id?: number
  parent_id?: number
  process_id?: number
  status?: string
  color?: string
  content?: string
  task_id?: number
  resource_id?: number
  quantity?: number
  user_id?: number
  state_id?: number
  is_available?: boolean
}

/** Project group inside the /planning/processes aggregate (its processes carry tasks/milestones). */
interface PlanningProjectGroup extends Omit<DtoDetailedProject, 'processes'> {
  processes?: DtoDetailedProcess[]
}

/** User fields read from the roster cache (for offline member rows) */
interface EmployeeFields {
  name?: string
  preset?: string
  position?: string
  manager_id?: number
  hire_date?: string
  termination_date?: string
}

/** Resource code/name read from the resources cache (for the task badge) */
interface ResourceFields {
  code?: string
  title?: string
}

/** State code/name/availability read from the states cache (for cell abbreviation/color) */
interface StateFields {
  state_code?: string
  state_name?: string
  is_available?: boolean
}

function pathnameOf(url: string): string {
  const plain = stripUserPrefix(url)
  try {
    return new URL(plain).pathname
  } catch {
    return plain.split('?')[0]
  }
}

/** id from the last path segment (PUT/DELETE /entity/{id}) */
function entryId(entry: ProjectionEntry): number | undefined {
  const p = pathnameOf(entry.url).replace(/\/+$/, '')
  const seg = p.split('/').pop() ?? ''
  const n = Number(seg)
  return Number.isFinite(n) ? n : undefined
}

/** Walk the cache entries, apply the mutation to data, write when changed */
async function forEachCacheKey(
  match: (path: string) => boolean,
  mutate: (body: CachedBody, key: string) => void,
): Promise<void> {
  const keys = await idbKeys(CACHE_STORE)
  for (const key of keys) {
    if (!match(pathnameOf(key))) continue
    const cached = await idbGet<CachedEntryLike>(CACHE_STORE, key)
    if (!cached || typeof cached.data !== 'object' || cached.data == null) continue
    const before = JSON.stringify(cached.data)
    mutate(cached.data, key)
    if (JSON.stringify(cached.data) !== before) {
      await idbPut(CACHE_STORE, key, cached)
    }
  }
}

/** Mutation for a listing { items, total } */
function applyListMutation<T extends { id?: number }>(
  payload: ListPayload<T>,
  entry: ProjectionEntry,
  makeItem: (body: MutationBody | undefined, tempId?: number) => T | undefined,
): void {
  const items = payload.items
  const body = entry.body as MutationBody | undefined
  const id = entryId(entry)
  const method = (entry.method || '').toUpperCase()
  switch (method) {
    case 'POST': {
      const item = makeItem(body, entry.tempId)
      if (item && !items.some((x) => x.id === item.id)) {
        items.push(item)
        payload.total = (payload.total ?? items.length - 1) + 1
      }
      break
    }
    case 'PUT': {
      if (id == null) break
      const i = items.findIndex((x) => x.id === id)
      if (i >= 0) items[i] = { ...items[i], ...(body ?? {}) }
      break
    }
    case 'DELETE': {
      if (id == null) break
      const i = items.findIndex((x) => x.id === id)
      if (i >= 0) {
        items.splice(i, 1)
        payload.total = Math.max(0, (payload.total ?? 0) - 1)
      }
      break
    }
    default:
      break
  }
}

function listApplier<T extends { id?: number }>(
  path: string,
  make: (b: MutationBody | undefined, tempId?: number) => T | undefined,
) {
  return (entry: ProjectionEntry): Promise<void> =>
    forEachCacheKey((p) => p === path, (cachedBody) => {
      const data = cachedBody.data as ListPayload<T> | undefined
      if (!data || !Array.isArray(data.items)) return
      applyListMutation(data, entry, make)
    })
}

// Synthesize created objects from the request body (with a temporary id)
const makeResource = (b: MutationBody | undefined, tempId?: number): DtoResourceResponse => ({
  id: tempId ?? -1,
  code: b?.code,
  title: b?.title,
  owner_id: b?.owner_id,
  employees_count: 0,
})
const makeEmployee = (b: MutationBody | undefined, tempId?: number): DtoUserResponse => ({
  id: tempId ?? -1,
  name: b?.name,
  preset: b?.preset ?? 'worker',
  position: b?.position,
  manager_id: b?.manager_id,
  hire_date: b?.hire_date,
  termination_date: b?.termination_date,
  username: b?.username,
})
const makeProject = (b: MutationBody | undefined, tempId?: number): DtoProjectResponse => ({
  id: tempId ?? -1,
  code: b?.code,
  start_date: b?.start_date,
  end_date: b?.end_date,
  priority: b?.priority ?? 100,
  owner_id: b?.owner_id,
})
const makeProcess = (b: MutationBody | undefined, tempId?: number): DtoProcess => ({
  id: tempId ?? -1,
  title: b?.title,
  project_id: b?.project_id,
  start_date: b?.start_date,
  end_date: b?.end_date,
  owner_id: b?.owner_id,
})
const makeTask = (b: MutationBody | undefined, tempId?: number): DtoDetailedTask => ({
  id: tempId ?? -1,
  title: b?.title,
  process_id: b?.process_id,
  parent_id: b?.parent_id,
  status: b?.status ?? 'not_started',
  start_date: b?.start_date,
  end_date: b?.end_date,
  resources: [],
})
const makeMilestone = (b: MutationBody | undefined, tempId?: number): DtoMilestone => ({
  id: tempId ?? -1,
  title: b?.title,
  content: b?.content ?? '',
  date: b?.date,
  process_id: b?.process_id,
})
const makeAssignment = (b: MutationBody | undefined, tempId?: number): DtoAssignmentResponse => ({
  id: tempId ?? -1,
  task_id: b?.task_id,
  resource_id: b?.resource_id,
  quantity: b?.quantity,
})

/** Aggregate /planning/projects: projects with priority */
async function applyPlanningProjects(entry: ProjectionEntry): Promise<void> {
  const body = entry.body as MutationBody | undefined
  const method = (entry.method || '').toUpperCase()
  await forEachCacheKey((p) => p === '/api/v1/planning/projects', (cachedBody) => {
    const data = cachedBody.data as DtoProjectPlanning | undefined
    const projects = data?.projects
    if (!Array.isArray(projects)) return
    const id = entryId(entry)
    if (method === 'POST') {
      const item = {
        id: entry.tempId ?? -1,
        project_code: body?.code,
        start_date: body?.start_date,
        end_date: body?.end_date,
        priority: body?.priority ?? 100,
        owner_id: body?.owner_id,
      }
      if (!projects.some((p) => p.id === item.id)) projects.push(item)
    } else if (method === 'PUT') {
      if (id == null) return
      const i = projects.findIndex((p) => p.id === id)
      if (i >= 0) projects[i] = { ...projects[i], ...(body ?? {}) }
    } else if (method === 'DELETE') {
      if (id == null) return
      const i = projects.findIndex((p) => p.id === id)
      if (i >= 0) projects.splice(i, 1)
    }
  })
}

/** Aggregate /planning/processes: processes inside projects */
async function applyPlanningProcesses(entry: ProjectionEntry): Promise<void> {
  const body = entry.body as MutationBody | undefined
  const method = (entry.method || '').toUpperCase()
  await forEachCacheKey((p) => p === '/api/v1/planning/processes', (cachedBody) => {
    const data = cachedBody.data as { projects?: PlanningProjectGroup[] } | undefined
    const projects = data?.projects
    if (!Array.isArray(projects)) return
    const id = entryId(entry)
    if (entry.entity === 'project') {
      if (method === 'POST' && !projects.some(project => project.id === entry.tempId)) projects.push({ id: entry.tempId, project_code: body?.code, processes: [] })
      if (method === 'PUT') { const project = projects.find(project => project.id === id); if (project) Object.assign(project, body) }
      if (method === 'DELETE') data!.projects = projects.filter(project => project.id !== id)
      return
    }
    if (method === 'POST') {
      const pid = body?.project_id
      const pr = projects.find((p) => p.id === pid)
      if (!pr) return
      pr.processes = pr.processes ?? []
      const item = {
        id: entry.tempId ?? -1,
        title: body?.title,
        start_date: body?.start_date,
        end_date: body?.end_date,
        project_id: pid,
        owner_id: undefined,
      }
      if (!pr.processes.some((x) => x.id === item.id)) pr.processes.push(item)
    } else if (method === 'PUT') {
      if (id == null) return
      for (const pr of projects) {
        const list = pr.processes ?? []
        const i = list.findIndex((x) => x.id === id)
        if (i >= 0) {
          list[i] = { ...list[i], ...(body ?? {}) }
          return
        }
      }
    } else if (method === 'DELETE') {
      if (id == null) return
      // A project deletion cascades its processes server-side: drop the whole
      // project group (processes included) from the cached processes aggregate.
      if (/^\/api\/v1\/project\/\d+$/.test(pathnameOf(entry.url))) {
        const i = projects.findIndex((p) => p.id === id)
        if (i >= 0) projects.splice(i, 1)
        return
      }
      for (const pr of projects) {
        const list = pr.processes ?? []
        const i = list.findIndex((x) => x.id === id)
        if (i >= 0) {
          list.splice(i, 1)
          return
        }
      }
    }
  })
}

/** Finds a task (top-level or subtask) among the cached processes. */
function findTaskInProcesses(
  processes: DtoDetailedProcess[],
  taskId: number,
): DtoDetailedTask | undefined {
  for (const pr of processes) {
    const t = (pr.tasks ?? []).find((x) => x.id === taskId)
    if (t) return t
    const s = (pr.tasks ?? [])
      .flatMap((x) => x.subtasks ?? [])
      .find((x) => x.id === taskId)
    if (s) return s
  }
  return undefined
}

/** Aggregate /planning/tasks: tasks/milestones/assignments inside processes */
async function applyPlanningTasks(
  entry: ProjectionEntry,
  kind: 'task' | 'milestone' | 'assignment',
): Promise<void> {
  const body = entry.body as MutationBody | undefined
  const method = (entry.method || '').toUpperCase()
  // Resource code/name for the task badge on offline assignment (from the reference cache)
  const resourceFields: ResourceFields =
    kind === 'assignment' && ['POST', 'PUT'].includes(method)
      ? await getResourceFields(body?.resource_id)
      : {}
  await forEachCacheKey((p) => p === '/api/v1/planning/tasks', (cachedBody) => {
    const data = cachedBody.data as DtoTaskPlanning | undefined
    const processes = data?.processes
    if (!Array.isArray(processes)) return
    const id = entryId(entry)

    if (kind === 'task') {
      if (method === 'POST') {
        // Subtask (operation): created inside the parent's subtask list.
        const parentId = body?.parent_id
        const pid = body?.process_id
        const item = {
          id: entry.tempId ?? -1,
          title: body?.title,
          color: body?.color,
          status: body?.status ?? 'not_started',
          parent_id: parentId,
          process_id: pid,
          start_date: body?.start_date,
          end_date: body?.end_date,
          resources: [],
          subtasks: [],
        }
        if (parentId != null) {
          const parent = findTaskInProcesses(processes, parentId)
          if (!parent) return
          parent.subtasks = parent.subtasks ?? []
          if (!parent.subtasks.some((x) => x.id === item.id)) parent.subtasks.push(item)
          return
        }
        const pr = processes.find((p) => p.id === pid)
        if (!pr) return
        pr.tasks = pr.tasks ?? []
        if (!pr.tasks.some((x) => x.id === item.id)) pr.tasks.push(item)
      } else if (method === 'PUT') {
        if (id == null) return
        for (const pr of processes) {
          const tasks = pr.tasks ?? []
          const i = tasks.findIndex((x) => x.id === id)
          if (i >= 0) {
            tasks[i] = { ...tasks[i], ...(body ?? {}) }
            return
          }
          const t = tasks.find((x) => (x.subtasks ?? []).some((s) => s.id === id))
          if (t) {
            const subtasks = t.subtasks ?? []
            const si = subtasks.findIndex((s) => s.id === id)
            if (si >= 0) {
              subtasks[si] = { ...subtasks[si], ...(body ?? {}) }
              return
            }
          }
        }
      } else if (method === 'DELETE') {
        if (id == null) return
        // A project deletion cascades its processes (and their tasks) on the
        // server: drop every process of the project from the cached aggregate.
        if (/^\/api\/v1\/project\/\d+$/.test(pathnameOf(entry.url))) {
          data!.processes = processes.filter(process => process.project_id !== id)
          return
        }
        for (const pr of processes) {
          const tasks = pr.tasks ?? []
          const i = tasks.findIndex((x) => x.id === id)
          if (i >= 0) {
            tasks.splice(i, 1)
            return
          }
          const t = tasks.find((x) => (x.subtasks ?? []).some((s) => s.id === id))
          if (t) {
            const subtasks = t.subtasks ?? []
            const si = subtasks.findIndex((s) => s.id === id)
            if (si >= 0) subtasks.splice(si, 1)
            return
          }
        }
      }
    } else if (kind === 'milestone') {
      if (method === 'POST') {
        const pid = body?.process_id
        const pr = processes.find((p) => p.id === pid)
        if (!pr) return
        pr.milestones = pr.milestones ?? []
        const item = {
          id: entry.tempId ?? -1,
          title: body?.title,
          content: body?.content ?? '',
          date: body?.date,
        }
        if (!pr.milestones.some((x) => x.id === item.id)) pr.milestones.push(item)
      } else if (method === 'PUT') {
        if (id == null) return
        for (const pr of processes) {
          const milestones = pr.milestones ?? []
          const i = milestones.findIndex((x) => x.id === id)
          if (i >= 0) {
            milestones[i] = { ...milestones[i], ...(body ?? {}) }
            return
          }
        }
      } else if (method === 'DELETE') {
        if (id == null) return
        for (const pr of processes) {
          const milestones = pr.milestones ?? []
          const i = milestones.findIndex((x) => x.id === id)
          if (i >= 0) {
            milestones.splice(i, 1)
            return
          }
        }
      }
    } else if (kind === 'assignment') {
      const tasks = processes.flatMap(process => (process.tasks ?? []).flatMap(task => [task, ...task.subtasks ?? []]))
      if (method === 'POST') {
        const task = tasks.find(task => task.id === body?.task_id)
        if (task) task.resources = addResourceAssignment(task.resources ?? [], { id: body?.resource_id, assignment_id: entry.tempId ?? -1, quantity: body?.quantity, ...resourceFields })
      } else {
        const source = tasks.find(task => task.resources?.some(resource => resource.assignment_id === id))
        const resource = source?.resources?.find(resource => resource.assignment_id === id)
        if (!source || !resource) return
        const target = body?.task_id != null ? tasks.find(task => task.id === body.task_id) : source
        if (method === 'PUT' && !target) return
        source.resources = source.resources?.filter(resource => resource.assignment_id !== id)
        if (method === 'PUT') target!.resources = addResourceAssignment(target!.resources ?? [], { ...resource, ...resourceFields, id: body?.resource_id ?? resource.id, quantity: body?.quantity ?? resource.quantity })
      }
    }
  })
}

/** Array /timesheet/states */
async function applyState(entry: ProjectionEntry): Promise<void> {
  const body = entry.body as MutationBody | undefined
  const method = (entry.method || '').toUpperCase()
  await forEachCacheKey((p) => p === '/api/v1/timesheet/states', (cachedBody) => {
    const data = cachedBody.data as DtoStateResponse[] | undefined
    if (!Array.isArray(data)) return
    const id = entryId(entry)
    if (method === 'POST') {
      const item = { id: entry.tempId ?? -1, ...(body ?? {}) }
      if (!data.some((s) => s.id === item.id)) data.push(item)
    } else if (method === 'PUT') {
      if (id == null) return
      const i = data.findIndex((s) => s.id === id)
      if (i >= 0) data[i] = { ...data[i], ...(body ?? {}) }
    } else if (method === 'DELETE') {
      if (id == null) return
      const i = data.findIndex((s) => s.id === id)
      if (i >= 0) data.splice(i, 1)
    }
  })
}

function parseEmployeeDays(entry: ProjectionEntry): {
  employeeId?: number
  start?: string
  end?: string
  stateId?: number
} {
  try {
    // In production the request URL is relative (basePath /api/v1) — without a base
    // new URL() throws, and timesheet deltas were silently not applied.
    const u = new URL(entry.url, 'https://mvs.local')
    const m = u.pathname.match(/\/user\/(\d+)\/days/)
    const stateRaw = u.searchParams.get('state_id')
    const stateN = stateRaw ? Number(stateRaw) : NaN
    return {
      employeeId: m ? Number(m[1]) : undefined,
      start: u.searchParams.get('start_date') ?? undefined,
      end: u.searchParams.get('end_date') ?? undefined,
      stateId: Number.isFinite(stateN) ? stateN : undefined,
    }
  } catch {
    return {}
  }
}

/** Full status info from the states cache (for cell abbreviation/color) */
async function getStateFields(stateId: number | undefined): Promise<StateFields> {
  if (stateId == null) return {}
  const keys = await idbKeys(CACHE_STORE)
  for (const key of keys) {
    if (pathnameOf(key) !== '/api/v1/timesheet/states') continue
    const cached = await idbGet<{ data: { data?: DtoStateResponse[] } }>(CACHE_STORE, key)
    const arr = cached?.data?.data
    if (Array.isArray(arr)) {
      const st = arr.find((s) => s.id === stateId)
      if (st) {
        return { state_code: st.code, state_name: st.name, is_available: st.is_available }
      }
    }
    // Keep scanning ALL cached pages for the id (the list is cached per page):
    // the first page may predate a later page that already contains the target.
  }
  return {}
}

/** Resource code/name from the /api/v1/resources reference cache (for the task badge) */
async function getResourceFields(resourceId: number | undefined): Promise<ResourceFields> {
  if (resourceId == null) return {}
  const keys = await idbKeys(CACHE_STORE)
  for (const key of keys) {
    if (pathnameOf(key) !== '/api/v1/resources') continue
    const cached = await idbGet<{ data: { data?: DtoResourceResponse[] } }>(CACHE_STORE, key)
    const payload = cached?.data?.data as DtoResourceResponse[] | { items?: DtoResourceResponse[] } | undefined
    const arr = Array.isArray(payload) ? payload : payload?.items
    if (Array.isArray(arr)) {
      const r = arr.find((x) => x.id === resourceId)
      if (r) {
        return { code: r.code, title: r.title }
      }
    }
    // Keep scanning ALL cached pages for the id (the list is cached per page).
  }
  return {}
}

/** Timesheet periods /user/{id}/days (windows are cached by ranges) */
async function applyPeriod(entry: ProjectionEntry): Promise<void> {
  const { employeeId, start, end, stateId } = parseEmployeeDays(entry)
  if (employeeId == null) return
  const body = entry.body as MutationBody | undefined
  const mode = entry.method.toUpperCase() === 'PUT' ? 'put' : 'delete'
  const from = mode === 'put' ? body?.start_date : start, to = mode === 'put' ? body?.end_date : end
  if (!from || !to) return
  const enrichment = mode === 'put' ? await getStateFields(body?.state_id) : {}
  const change = (periods: DtoUserStateResponse[]) => applyRangeSplit(periods, mode, from, to, mode === 'delete' ? stateId : undefined, mode === 'put' ? {
    id: -entry.ts, state_id: body?.state_id, ...enrichment,
  } as PutPeriodFields : undefined)
  const before: DtoUserStateResponse[] = [], resources = new Set<number>()
  let employeeName: string | undefined
  for (const key of await cache.keys()) {
    const saved = await cache.get<CachedEntryLike>(key), data = saved?.data?.data
    const path = pathnameOf(key)
    if (path === `/api/v1/user/${employeeId}/days` && Array.isArray(data)) before.push(...data)
    if (path === '/api/v1/user/days' && Array.isArray(data)) for (const row of data as DtoUserStatesResponse[]) if (row.user_id === employeeId) before.push(...row.days ?? [])
    const member = path.match(/\/resources\/(\d+)\/members$/)
    if (member && Array.isArray(data)) {
      const employee = (data as DtoResourceMemberResponse[]).find(row => row.id === employeeId)
      if (employee) { resources.add(Number(member[1])); employeeName = employee.name }
    }
  }
  const unique = [...new Map(before.map(period => [JSON.stringify(period), period])).values()], after = change(unique)
  await forEachCacheKey(path => path === `/api/v1/user/${employeeId}/days` || path === '/api/v1/user/days' || path === '/api/v1/timesheet/calendar' || /^\/api\/v1\/resources\/\d+\/absence$/.test(path), (saved, key) => {
    const path = pathnameOf(key)
    if (path === `/api/v1/user/${employeeId}/days` && Array.isArray(saved.data)) saved.data = change(saved.data as DtoUserStateResponse[])
    if (path === '/api/v1/user/days' && Array.isArray(saved.data)) for (const row of saved.data as DtoUserStatesResponse[]) if (row.user_id === employeeId) row.days = change(row.days ?? [])
    if (path === '/api/v1/timesheet/calendar') {
      const data = saved.data as { resources?: DtoResourceCalendar[] } | undefined
      if (data?.resources) for (const id of resources) data.resources = updatePeriodAvailability(data.resources, id, unique, after, from, to)
    }
    const absence = path.match(/\/resources\/(\d+)\/absence$/)
    if (absence && resources.has(Number(absence[1])) && Array.isArray(saved.data)) saved.data = replaceEmployeeAbsences(saved.data as DtoResourceAbsenceResponse[], after, employeeId, employeeName)
  })
}

/** User fields from the /api/v1/users reference cache (offline member addition) */
async function getUserFields(userId: number | undefined): Promise<EmployeeFields> {
  if (userId == null) return {}
  const keys = await idbKeys(CACHE_STORE)
  for (const key of keys) {
    if (pathnameOf(key) !== '/api/v1/user') continue
    const cached = await idbGet<{ data: { data?: { items?: DtoUserResponse[] } } }>(CACHE_STORE, key)
    const u = cached?.data?.data?.items?.find((x) => x.id === userId)
    if (u) {
      return {
        name: u.name,
        preset: u.preset,
        position: u.position,
        manager_id: u.manager_id,
        hire_date: u.hire_date,
        termination_date: u.termination_date,
      }
    }
    // Keep scanning ALL cached pages for the id (the roster is cached per
    // page): a first page cached before a limit=500 page may lack the target.
  }
  return {}
}

/** Resource members array /api/v1/resources/{id}/members */
async function applyMembers(entry: ProjectionEntry): Promise<void> {
  const body = entry.body as MutationBody | undefined
  const method = (entry.method || '').toUpperCase()
  const path = pathnameOf(entry.url).replace(/\/+$/, '')
  const m = path.match(/\/api\/v1\/resources\/(\d+)\/members(?:\/(\d+))?$/)
  if (!m) return
  const resourceId = Number(m[1])
  const userId = m[2] ? Number(m[2]) : undefined
  const fields: EmployeeFields = method === 'POST' ? await getUserFields(body?.user_id) : {}
  await forEachCacheKey((p) => p === `/api/v1/resources/${resourceId}/members`, (cachedBody) => {
    const data = cachedBody.data as DtoResourceMemberResponse[] | undefined
    if (!Array.isArray(data)) return
    if (method === 'POST') {
      const item = { id: body?.user_id ?? entry.tempId ?? -1, ...fields }
      if (!data.some((x) => x.id === item.id)) data.push(item)
    } else if (method === 'DELETE' && userId != null) {
      const i = data.findIndex((x) => x.id === userId)
      if (i >= 0) data.splice(i, 1)
    }
  })
  // Member counter in the resources reference
  if (method === 'POST' || method === 'DELETE') {
    await forEachCacheKey((p) => p === '/api/v1/resources', (cachedBody) => {
      const data = cachedBody.data as { items?: DtoResourceResponse[] } | undefined
      const res = data?.items?.find((r) => r.id === resourceId)
      if (!res) return
      if (method === 'POST') res.employees_count = (res.employees_count ?? 0) + 1
      else res.employees_count = Math.max(0, (res.employees_count ?? 0) - 1)
    })
  }
}

/**
 * Applies an offline delta to saved GET responses. Called on every
 * queue write. Errors are not critical — the cache simply won't update.
 */
async function applyPlanningOwnerChange(entry: ProjectionEntry): Promise<void> {
  const patch = entry.body as MutationBody | undefined
  if (entry.method.toUpperCase() !== 'PUT' || patch?.owner_id == null) return
  const id = entryId(entry)
  await forEachCacheKey((path) => path === '/api/v1/planning/tasks', (body) => {
    const data = body.data as DtoTaskPlanning | undefined
    for (const process of data?.processes ?? []) {
      if (entry.entity === 'process' && process.id === id && process.owner_id !== patch.owner_id) {
        process.owner_id = patch.owner_id
        for (const task of process.tasks ?? []) task.resources = []
      }
      if (entry.entity === 'resource' && process.owner_id !== patch.owner_id) {
        for (const task of process.tasks ?? []) task.resources = task.resources?.filter((r) => r.id !== id)
      }
    }
  })
}

async function applyProcessTaskAggregate(entry: ProjectionEntry): Promise<void> {
  await forEachCacheKey(path => path === '/api/v1/planning/tasks', cached => {
    const data = cached.data as DtoTaskPlanning | undefined
    if (!data?.processes) return
    const id = entryId(entry), body = entry.body as MutationBody | undefined
    if (entry.method === 'POST') {
      if (!data.processes.some(process => process.id === entry.tempId)) data.processes.push({ ...makeProcess(body, entry.tempId), tasks: [], milestones: [], dependencies: [] })
    } else if (entry.method === 'PUT') {
      const process = data.processes.find(process => process.id === id)
      if (process) Object.assign(process, body)
    } else if (entry.method === 'DELETE') data.processes = data.processes.filter(process => process.id !== id)
  })
}
async function applyOrderOrDependency(entry: ProjectionEntry): Promise<void> {
  const body = entry.body as { ids?: number[]; project_id?: number; process_id?: number; depends_on_task_id?: number; type?: string } | undefined
  const ordered = <T extends { id?: number }>(rows: T[]) => {
    const order = new Map((body?.ids ?? []).map((id, index) => [id, index]))
    return [...rows].sort((left, right) => (order.get(left.id!) ?? rows.length) - (order.get(right.id!) ?? rows.length))
  }
  await forEachCacheKey(path => path === '/api/v1/planning/tasks' || path === '/api/v1/planning/processes', cached => {
    const data = cached.data as DtoTaskPlanning & { projects?: PlanningProjectGroup[] } | undefined
    if (!data) return
    if (entry.entity === 'reorder') {
      if (pathnameOf(entry.url) === '/api/v1/process/order') for (const project of data.projects ?? []) if (project.id === body?.project_id) project.processes = ordered(project.processes ?? [])
      if (pathnameOf(entry.url) === '/api/v1/task/order') for (const process of data.processes ?? []) if (process.id === body?.process_id) process.tasks = ordered(process.tasks ?? [])
      return
    }
    const match = pathnameOf(entry.url).match(/\/task\/(-?\d+)\/dependencies(?:\/(-?\d+))?$/)
    if (!match) return
    const taskId = Number(match[1]), dependencyId = Number(match[2])
    const process = (data.processes ?? []).find(process => findTaskInProcesses([process], taskId))
    if (!process) return
    process.dependencies ??= []
    if (entry.method === 'POST' && !process.dependencies.some(item => item.id === entry.tempId)) process.dependencies.push({ id: entry.tempId, task_id: taskId, depends_on_task_id: body?.depends_on_task_id, type: body?.type })
    if (entry.method === 'PUT') { const dependency = process.dependencies.find(item => item.id === dependencyId); if (dependency) Object.assign(dependency, body) }
    if (entry.method === 'DELETE') process.dependencies = process.dependencies.filter(item => item.id !== dependencyId)
  })
}
async function applyToCache(entry: ProjectionEntry): Promise<void> {
  switch (entry.entity) {
      case 'resource':
        await applyPlanningOwnerChange(entry)
        await forEachCacheKey((path) => path === '/local/resource-header', (body, key) => {
          if (!Array.isArray(body)) return
          const owner = new URL(stripUserPrefix(key), 'https://cache.invalid').searchParams.get('owner_id')
          applyListMutation({ items: body as DtoResourceResponse[] }, entry, makeResource)
          if (owner && owner !== 'all') for (let i = body.length - 1; i >= 0; i--) if (body[i]?.owner_id !== Number(owner)) body.splice(i, 1)
        })
        await listApplier('/api/v1/resources', makeResource)(entry)
        break
      case 'user':
        await listApplier('/api/v1/user', makeEmployee)(entry)
        break
      case 'member':
        await applyMembers(entry)
        break
      case 'state':
        await applyState(entry)
        break
      case 'period':
        await applyPeriod(entry)
        break
      case 'project':
        await listApplier('/api/v1/project', makeProject)(entry)
        await applyPlanningProjects(entry)
        // A project DELETE cascades its processes/tasks server-side — clean
        // them from the cached planning aggregates too (POST/PUT find nothing
        // there and are no-ops).
        await applyPlanningProcesses(entry)
        await applyPlanningTasks(entry, 'task')
        await applyPlanningTasks(entry, 'milestone')
        await applyPlanningTasks(entry, 'assignment')
        break
      case 'process':
        await applyPlanningOwnerChange(entry)
        await applyProcessTaskAggregate(entry)
        await listApplier('/api/v1/process', makeProcess)(entry)
        await applyPlanningProcesses(entry)
        break
      case 'task':
        await listApplier('/api/v1/task', makeTask)(entry)
        await applyPlanningTasks(entry, 'task')
        break
      case 'milestone':
        await listApplier('/api/v1/milestone', makeMilestone)(entry)
        await applyPlanningTasks(entry, 'milestone')
        break
      case 'assignment':
        await listApplier('/api/v1/assignment', makeAssignment)(entry)
        await applyPlanningTasks(entry, 'assignment')
        break
      case 'dependency':
      case 'reorder':
        await applyOrderOrDependency(entry)
        break
      default:
        break
    }
}
  return { applyToCache }
}
