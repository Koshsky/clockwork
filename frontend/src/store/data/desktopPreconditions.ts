export type DesktopBaseline = Record<string, string>

export interface DesktopBaselineRequest {
  route?: string
  operation?: string
  operationId?: string
  preconditions?: DesktopBaseline
  path?: Record<string, string | number>
  query?: Record<string, string | number | boolean>
  body?: unknown
}

export interface DesktopPreconditionsSources {
  planningProjects?: unknown
  planningProcesses?: unknown
  planningTasks?: unknown
  resources?: unknown
  states?: unknown
  stateBaseline?: DesktopBaseline
  periodBaseline?: (userId: number, startDate: string, endDate: string) => DesktopBaseline | undefined
}

export type DesktopPreconditionsRequest = DesktopBaselineRequest

type Row = Record<string, unknown>
type Kind = 'project' | 'process' | 'task' | 'milestone' | 'assignment' | 'resource' | 'state' | 'dependency'
interface Context { projectId?: number; processId?: number; taskId?: number }
type Source = 'projects' | 'processes' | 'tasks' | 'resources' | 'states'
interface Entity { source: Source; row: Row; kind: Kind; id: number; projectId?: number; processId?: number; taskId?: number; resourceId?: number; badge?: boolean }
const required = () => { throw new Error('COMMAND_BASELINE_REQUIRED') }
const ambiguous = () => { throw new Error('COMMAND_BASELINE_AMBIGUOUS') }
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)

function identifier(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^-?[1-9]\d*$/.test(value)) return undefined
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) && id !== 0 ? id : undefined
}

function key(kind: string, id: unknown): string {
  const value = identifier(id)
  if (value === undefined) return required()
  return `${kind}:${value}`
}

function add(result: DesktopBaseline, name: string, value: unknown): void {
  if (typeof value !== 'string' || !value) return required()
  if (Object.prototype.hasOwnProperty.call(result, name) && result[name] !== value) return ambiguous()
  result[name] = value
}

function effectiveToken(row: Row, name: string): unknown {
  const baseline = object(row._baseline) ? row._baseline : {}
  const pending = object(row._pending) ? row._pending : {}
  return typeof baseline[name] === 'string' && typeof pending[name] === 'string' && pending[name] ? `local:${pending[name]}` : baseline[name]
}

function fromRow(result: DesktopBaseline, entity: Entity, names: string[]): void {
  for (const name of names) {
    const value = effectiveToken(entity.row, name)
    if (typeof value === 'string' && value) add(result, name, value)
    else if (/^[a-z_]+:-[1-9]\d*$/.test(name)) add(result, name, 'pending')
    else required()
  }
}

function collect(value: unknown, kind: Kind, parent: Context, result: Entity[], source: Source): void {
  if (Array.isArray(value)) { for (const row of value) collect(row, kind, parent, result, source); return }
  if (!object(value)) return
  const id = identifier(value.id)
  if (kind === 'project' && identifier(value.project_id) !== undefined) kind = 'process'
  if (kind === 'process' && identifier(value.process_id) !== undefined) kind = 'task'
  const context = {
    projectId: kind === 'project' && id !== undefined ? id : identifier(value.project_id) ?? parent.projectId,
    processId: kind === 'process' && id !== undefined ? id : identifier(value.process_id) ?? parent.processId,
    taskId: kind === 'task' && id !== undefined ? id : identifier(value.task_id) ?? parent.taskId,
  }
  if (id !== undefined) result.push({ source, row: value, kind, id, ...context, resourceId: identifier(value.resource_id) })
  for (const [field, child] of Object.entries(value)) {
    if (field === 'items' || field === 'data') collect(child, kind, context, result, source)
    else if (field === 'projects') collect(child, 'project', context, result, source)
    else if (field === 'processes') collect(child, 'process', context, result, source)
    else if (field === 'tasks' || field === 'subtasks') collect(child, 'task', context, result, source)
    else if (field === 'milestones') collect(child, 'milestone', context, result, source)
    else if (field === 'dependencies') collect(child, 'dependency', context, result, source)
    else if (field === 'resources' && kind === 'task' && Array.isArray(child)) {
      for (const badge of child) if (object(badge) && identifier(badge.assignment_id) !== undefined) result.push({ source, row: badge, kind: 'assignment', id: identifier(badge.assignment_id)!, ...context, resourceId: identifier(badge.id), badge: true })
    }
  }
}

function entities(sources: DesktopPreconditionsSources): Entity[] {
  const result: Entity[] = []
  collect(sources.planningProjects, 'project', {}, result, 'projects')
  collect(sources.planningProcesses, 'project', {}, result, 'processes')
  collect(sources.planningTasks, 'process', {}, result, 'tasks')
  collect(sources.resources, 'resource', {}, result, 'resources')
  collect(sources.states, 'state', {}, result, 'states')
  return result
}

function matching(rows: Entity[], kind: Kind, id: unknown, preferred?: Source): Entity[] {
  const value = identifier(id)
  if (value === undefined) return required()
  const candidates = rows.filter(row => row.kind === kind && row.id === value)
  const priority: Source[] = kind === 'project' ? ['projects', 'processes', 'tasks'] : kind === 'process' ? ['processes', 'tasks'] : kind === 'resource' ? ['resources'] : kind === 'state' ? ['states'] : ['tasks']
  const source = (preferred ? [preferred, ...priority] : priority).find(name => candidates.some(row => row.source === name))
  const found = candidates.filter(row => row.source === source)
  if (!found.length) return required()
  for (const field of ['projectId', 'processId', 'taskId', 'resourceId'] as const) {
    if (new Set(found.map(row => row[field]).filter(item => item !== undefined)).size > 1) return ambiguous()
  }
  return found
}

function aggregateRows(result: DesktopBaseline, rows: Entity[], kind: 'project' | 'process' | 'resource', id: unknown, preferred?: Source): void {
  const name = key(kind, id), value = identifier(id)!
  const found = rows.filter(row => row.kind === kind && row.id === value)
  if (found.length) for (const row of matching(rows, kind, value, preferred)) fromRow(result, row, [name])
  else if (value < 0) add(result, name, 'pending')
  else required()
}

function processEntity(result: DesktopBaseline, rows: Entity[], entity: Entity): void {
  if (entity.processId === undefined) return required()
  const name = key('process', entity.processId)
  if (entity.id < 0 && !object(entity.row._baseline)) aggregateRows(result, rows, 'process', entity.processId, 'tasks')
  else fromRow(result, entity, [name])
}

function taskRows(result: DesktopBaseline, rows: Entity[], id: unknown): Entity[] {
  const found = matching(rows, 'task', id)
  for (const row of found) processEntity(result, rows, row)
  return found
}

function stateCatalog(result: DesktopBaseline, sources: DesktopPreconditionsSources, rows: Entity[]): void {
  const own = sources.stateBaseline ?? (object(sources.states) && object(sources.states._baseline) ? sources.states._baseline : undefined)
  if (own) add(result, 'states', own.states)
  const states = rows.filter(row => row.kind === 'state' && (row.id > 0 || object(row.row._baseline)))
  if (!states.length && !own) return required()
  for (const row of states) fromRow(result, row, ['states'])
}

const eligible = new Set([
  'POST /project', 'PUT /project/{id}', 'DELETE /project/{id}',
  'POST /process', 'PUT /process/order', 'PUT /process/{id}', 'DELETE /process/{id}',
  'POST /task', 'PUT /task/order', 'PUT /task/{id}', 'DELETE /task/{id}',
  'POST /task/{id}/dependencies', 'PUT /task/{id}/dependencies/{dep_id}', 'DELETE /task/{id}/dependencies/{dep_id}',
  'POST /milestone', 'PUT /milestone/{id}', 'DELETE /milestone/{id}',
  'POST /assignment', 'PUT /assignment/{id}', 'DELETE /assignment/{id}',
  'POST /resources', 'PUT /resources/{id}', 'DELETE /resources/{id}',
  'POST /resources/{id}/members', 'DELETE /resources/{id}/members/{userId}',
  'POST /timesheet/states', 'PUT /timesheet/states/{id}', 'DELETE /timesheet/states/{id}',
  'PUT /user/{id}/days', 'DELETE /user/{id}/days',
])

function captureAssignment(result: DesktopBaseline, rows: Entity[], request: DesktopBaselineRequest, body: Row): void {
  const old = request.path?.id == null ? [] : matching(rows, 'assignment', request.path.id)
  for (const row of old) {
    processEntity(result, rows, row)
    const resourceKey = key('resource', row.resourceId)
    if (row.id < 0 && !object(row.row._baseline)) aggregateRows(result, rows, 'resource', row.resourceId)
    else fromRow(result, row, [resourceKey])
  }
  if (body.task_id != null && (!old.length || old[0]!.taskId !== identifier(body.task_id))) taskRows(result, rows, body.task_id)
  if (body.resource_id != null && (!old.length || old[0]!.resourceId !== identifier(body.resource_id))) aggregateRows(result, rows, 'resource', body.resource_id)
  if (!old.length && (body.task_id == null || body.resource_id == null)) required()
}

// Conditions belong to the actual loaded row; a parent or another view must not lend it a newer token.
export function captureDesktopPreconditions(request: DesktopBaselineRequest, sources: DesktopPreconditionsSources): DesktopBaseline | undefined {
  const route = request.route ?? request.operation ?? ''
  if (!eligible.has(route)) return undefined
  const result: DesktopBaseline = {}, rows = entities(sources), body = object(request.body) ? request.body : {}, id = request.path?.id
  if (route === 'POST /project' || route === 'POST /resources') return result
  if (route.includes('/user/{id}/days')) {
    const userId = identifier(id), start = body.start_date ?? request.query?.start_date, end = body.end_date ?? request.query?.end_date
    if (userId === undefined || typeof start !== 'string' || typeof end !== 'string') return required()
    const baseline = sources.periodBaseline?.(userId, start, end)
    if (!baseline) return required()
    add(result, key('user_days', userId), baseline[key('user_days', userId)])
    add(result, 'states', baseline.states)
  } else if (route.startsWith('POST /timesheet/states')) stateCatalog(result, sources, rows)
  else if (route.includes('/timesheet/states')) for (const row of matching(rows, 'state', id)) {
    if (row.id < 0 && !object(row.row._baseline)) stateCatalog(result, sources, rows)
    else fromRow(result, row, ['states'])
  }
  else if (route === 'POST /process' || route === 'PUT /process/order') aggregateRows(result, rows, 'project', body.project_id, 'processes')
  else if (route.includes('/project/')) aggregateRows(result, rows, 'project', id)
  else if (route.includes('/process/')) {
    const found = matching(rows, 'process', id)
    for (const row of found) fromRow(result, row, [key('process', row.id)])
    if (body.project_id != null && found[0]!.projectId !== identifier(body.project_id)) aggregateRows(result, rows, 'project', body.project_id, 'processes')
  } else if (route === 'PUT /task/order' || route === 'POST /task') {
    aggregateRows(result, rows, 'process', body.process_id, 'tasks')
    if (body.parent_id != null) taskRows(result, rows, body.parent_id)
  } else if (route.includes('/task/')) {
    taskRows(result, rows, id)
    if (body.depends_on_task_id != null) taskRows(result, rows, body.depends_on_task_id)
  } else if (route.includes('/milestone')) {
    const found = id == null ? [] : matching(rows, 'milestone', id)
    for (const row of found) processEntity(result, rows, row)
    if (body.process_id != null && (!found.length || found[0]!.processId !== identifier(body.process_id))) aggregateRows(result, rows, 'process', body.process_id, 'tasks')
    if (!found.length && body.process_id == null) required()
  } else if (route.includes('/assignment')) captureAssignment(result, rows, request, body)
  else if (route.includes('/resources/')) aggregateRows(result, rows, 'resource', id)
  return result
}

function targetKind(route: string): Kind | undefined {
  if (route.includes('/dependencies') || route.endsWith('/order') || route.includes('/members') || route.includes('/days')) return undefined
  if (route.includes('/timesheet/states')) return 'state'
  const kind = route.split(' ')[1]?.split('/')[1]
  return kind === 'resources' ? 'resource' : ['project', 'process', 'task', 'milestone', 'assignment'].includes(kind ?? '') ? kind as Kind : undefined
}

function acknowledgedKeys(row: Entity, revisions: DesktopBaseline): string[] {
  if (row.kind === 'state') return ['states']
  if (row.kind === 'project' || row.kind === 'process' || row.kind === 'resource') return [key(row.kind, row.id)]
  const result = row.processId === undefined ? Object.keys(revisions).filter(name => /^process:[1-9]\d*$/.test(name)) : [key('process', row.processId)]
  if (row.kind === 'assignment') result.push(key('resource', row.resourceId))
  return result
}

// Full DTO application is required before advancing a marker; cascading children and unrelated siblings stay untouched.
export function acknowledgeDesktopPreconditions(request: DesktopBaselineRequest, dto: unknown, revisions: DesktopBaseline, sources: DesktopPreconditionsSources, previous?: DesktopBaseline): void {
  const route = request.route ?? request.operation ?? '', kind = targetKind(route)
  if (!kind || route.startsWith('DELETE ') || !object(dto) || identifier(dto.id) === undefined) return
  const targetId = identifier(dto.id)!, pathId = identifier(request.path?.id)
  if (pathId !== undefined && pathId > 0 && !route.startsWith('POST ') && pathId !== targetId) return
  const rows = entities(sources)
  for (const entity of rows) {
    if (entity.kind !== kind || entity.id !== targetId) continue
    if (previous && object(entity.row._baseline)) {
      if (acknowledgedKeys(entity, revisions).some(name => {
        const current = effectiveToken(entity.row, name)
        return typeof current !== 'string' || current !== previous[name] && current !== revisions[name] && current !== (request.operationId ? `local:${request.operationId}` : undefined)
      })) continue
    }
    if (entity.badge) {
      if (entity.taskId !== identifier(dto.task_id)) continue
      Object.assign(entity.row, { id: dto.resource_id, assignment_id: dto.id, quantity: dto.quantity })
      entity.resourceId = identifier(dto.resource_id)
    } else {
      const projectCode = kind === 'project' && Object.prototype.hasOwnProperty.call(entity.row, 'project_code')
      Object.assign(entity.row, dto)
      if (projectCode && Object.prototype.hasOwnProperty.call(dto, 'code')) entity.row.project_code = dto.code
      entity.processId = identifier(dto.process_id) ?? entity.processId
    }
    const names = acknowledgedKeys(entity, revisions), marker: DesktopBaseline = {}
    if (!names.length || names.some(name => typeof revisions[name] !== 'string' || !revisions[name])) continue
    for (const name of names) marker[name] = revisions[name]!
    entity.row._baseline = marker
    if (object(entity.row._pending)) {
      for (const name of names) delete entity.row._pending[name]
      if (!Object.keys(entity.row._pending).length) delete entity.row._pending
    }
  }
}


function commandSource(route: string): Source | undefined {
  if (route.includes('/timesheet/states')) return 'states'
  if (route.includes('/resources')) return 'resources'
  const family = route.split(' ')[1]?.split('/')[1]
  if (family === 'project') return 'projects'
  if (family === 'process') return 'processes'
  if (family === 'task' || family === 'milestone' || family === 'assignment') return 'tasks'
  return undefined
}

// Only this window's actually updated chart can prove that a later edit observed its queued predecessor.
export function observeDesktopCommand(request: DesktopBaselineRequest, operationId: string, sources: DesktopPreconditionsSources, tempId?: number): void {
  const route = request.route ?? request.operation ?? '', source = commandSource(route)
  if (!source || !eligible.has(route) || !request.preconditions || !/^[a-zA-Z0-9:._-]{1,128}$/.test(operationId) || operationId === '.' || operationId === '..') return
  const rows = entities(sources).filter(row => row.source === source), captured = request.preconditions
  const createdKind = route.startsWith('POST ') ? targetKind(route) : undefined
  if (createdKind && tempId != null && tempId < 0) {
    for (const entity of rows) if (entity.kind === createdKind && entity.id === tempId) {
      const names = createdKind === 'project' || createdKind === 'process' || createdKind === 'resource'
        ? [key(createdKind, tempId)] : acknowledgedKeys(entity, captured)
      const baseline = object(entity.row._baseline) ? entity.row._baseline : {}
      const pending = object(entity.row._pending) ? entity.row._pending : {}
      for (const name of names) {
        if (typeof baseline[name] !== 'string') {
          if (typeof captured[name] === 'string') baseline[name] = captured[name]
          else if (/^[a-z_]+:-[1-9]\d*$/.test(name)) baseline[name] = 'pending'
          else continue
        }
        pending[name] = operationId
      }
      entity.row._baseline = baseline
      entity.row._pending = pending
    }
  }
  for (const entity of rows) {
    for (const [name, token] of Object.entries(captured)) {
      if (effectiveToken(entity.row, name) !== token) continue
      const pending = object(entity.row._pending) ? entity.row._pending : {}
      pending[name] = operationId
      entity.row._pending = pending
    }
  }
}
