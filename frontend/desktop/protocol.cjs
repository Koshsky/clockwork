'use strict'

const operations = require('./protocol-operations.json')
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const record = value => value != null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const optional = test => value => value === undefined || test(value)
const nullable = test => value => value === null || test(value)
const text = value => typeof value === 'string' && value.length <= 65536
const shortText = value => typeof value === 'string' && value.length <= 4096
const boolean = value => typeof value === 'boolean'
const number = value => typeof value === 'number' && Number.isFinite(value)
const id = value => Number.isSafeInteger(value) && value !== 0
const positive = value => Number.isSafeInteger(value) && value > 0
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const list = test => value => Array.isArray(value) && value.length <= 5000 && value.every(test)
const shape = fields => value => record(value) && Object.keys(value).every(key => own(fields, key)) && Object.entries(fields).every(([key, test]) => test(value[key]))
const optionalFields = fields => Object.fromEntries(Object.entries(fields).map(([key, test]) => [key, optional(test)]))
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
const voidInput = value => value === undefined || value === null
const page = { limit: optional(positive), offset: optional(value => Number.isSafeInteger(value) && value >= 0), search: optional(shortText) }
const range = { start: date, end: date }
const read = {
  'project.list': shape(page),
  'resource.list': shape({ ...page, ownerId: optional(positive) }),
  'resource.members': shape({ resourceId: id }),
  'resource.calendar': shape(range),
  'resource.absences': shape({ ...range, resourceId: id }),
  'employee.list': shape({ ...page, terminated: optional(boolean), staffOnly: optional(boolean) }),
  'timesheet.periods': shape({ ...range, employeeIds: list(id) }),
  'account.list': shape(page),
  'rbac.user': shape({ userId: positive }),
  'comment.list': shape({ taskId: id }),
  'assignment.list': shape({ taskId: id }),
  'audit.events': shape({ ...page, ...optionalFields({ userId: positive, user: shortText, entity: shortText, action: shortText, status: shortText, from: shortText, to: shortText, id: shortText, ip: shortText }) }),
}
for (const name of ['planning.projects', 'planning.processes', 'planning.tasks', 'timesheet.states', 'permissions.current', 'account.structure', 'account.profile', 'rbac.configuration', 'template.configuration', 'sync.queue']) read[name] = voidInput
const command = {}
const common = { owner_id: positive, responsible_id: positive, color: shortText }
const dates = { start_date: date, end_date: date }
const entities = {
  project: { code: shortText, priority: number, ...common, ...dates },
  process: { title: shortText, project_id: id, ...common, ...dates },
  task: { title: shortText, process_id: id, parent_id: id, status: shortText, ...common, ...dates },
  milestone: { title: shortText, content: text, process_id: id, color: shortText, date },
  resource: { code: shortText, title: shortText, owner_id: positive, color: shortText },
  state: { code: shortText, name: shortText, color: shortText, is_available: boolean },
}
for (const [name, fields] of Object.entries(entities)) {
  command[name + '.create'] = shape(optionalFields(fields))
  command[name + '.update'] = shape({ id, patch: shape(optionalFields(fields)) })
  command[name + '.delete'] = shape({ id })
}
const permission = shape({ resource: shortText, action: shortText, scope: optional(shortText), granted: optional(boolean) })
const preset = { tag: shortText, name: shortText, description: shortText }
const userFields = { username: shortText, first_name: shortText, last_name: shortText, middle_name: shortText, position: shortText, hire_date: date, termination_date: date, manager_id: nullable(positive), preset: nullable(shortText), password_hash: text, permissions: list(permission) }
Object.assign(command, {
  'task.move': shape({ id, ...range }),
  'dependency.create': shape({ taskId: id, dependency: shape({ depends_on_task_id: optional(id), type: optional(shortText) }) }),
  'dependency.update': shape({ id, patch: shape({ type: optional(shortText) }) }),
  'dependency.delete': shape({ id }),
  'assignment.create': shape({ task_id: optional(id), resource_id: optional(id), quantity: optional(number) }),
  'assignment.delete': shape({ id }),
  'resource.addMember': shape({ resourceId: id, userId: positive }),
  'resource.removeMember': shape({ resourceId: id, userId: positive }),
  'timesheet.assignRange': shape({ ...range, userId: positive, stateId: id }),
  'timesheet.clearRange': shape({ ...range, userId: positive }),
  'project.reorder': shape({ ids: list(id) }),
  'process.reorder': shape({ projectId: id, ids: list(id) }),
  'task.reorder': shape({ processId: id, ids: list(id) }),
  'comment.create': shape({ taskId: id, comment: shape({ content: optional(text), parent_id: optional(id) }) }),
  'comment.delete': shape({ id }),
  'account.create': shape(optionalFields(userFields)),
  'account.update': shape({ id: positive, patch: shape(optionalFields(Object.fromEntries(Object.entries(userFields).filter(([key]) => !['password_hash', 'permissions'].includes(key))))) }),
  'account.delete': shape({ id: positive }),
  'account.setManager': shape({ id: positive, managerId: nullable(positive) }),
  'rbac.upsertRule': shape({ preset: shortText, resource: shortText, action: shortText, scope: shortText }),
  'rbac.deleteRule': shape({ id: positive }),
  'rbac.createPreset': shape(optionalFields(preset)),
  'rbac.updatePreset': shape({ tag: shortText, patch: shape(optionalFields(preset)) }),
  'rbac.deletePreset': shape({ tag: shortText }),
  'rbac.saveUser': shape({ userId: positive, permissions: shape({ overrides: optional(list(permission)) }) }),
  'rbac.reset': voidInput,
})
const operationTemplate = shape(optionalFields({ title: shortText, color: shortText }))
const resourceBinding = shape(optionalFields({ resource_id: id, quantity: number }))
const taskTemplate = shape(optionalFields({ title: shortText, color: shortText, operations: list(operationTemplate), resources: list(resourceBinding) }))
const processTemplate = shape(optionalFields({ title: shortText, color: shortText, owner_id: positive, tasks: list(taskTemplate) }))
command['template.save'] = shape(optionalFields({ enabled: boolean, processes: list(processTemplate) }))
for (const [kind, definitions] of Object.entries({ read, command })) {
  if (JSON.stringify(Object.keys(definitions).sort()) !== JSON.stringify(Object.keys(operations[kind]).sort())) throw new Error('Desktop operation contract mismatch: ' + kind)
}

function bounded(value, maxBytes = 1024 * 1024) {
  let nodes = 0, bytes = 0
  const scale = Math.max(1, maxBytes / (1024 * 1024))
  const visit = (item, depth) => {
    if (++nodes > 20000 * scale || depth > 16 * scale) return false
    if (item == null || item === undefined || typeof item === 'boolean') return true
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); return item.length <= 65536 && bytes <= maxBytes }
    if (typeof item === 'number') return Number.isFinite(item)
    if (Array.isArray(item)) return item.length <= 5000 * scale && item.every(child => visit(child, depth + 1))
    return record(item) && Object.keys(item).length <= 256 * scale && Object.entries(item).every(([key, child]) => key.length <= 4096 && !['__proto__', 'constructor', 'prototype'].includes(key) && (bytes += Buffer.byteLength(key)) <= maxBytes && visit(child, depth + 1))
  }
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value) ?? '') <= maxBytes } catch { return false }
}
function validate(request) {
  if (!bounded(request) || !record(request) || request.protocol !== 1) return false
  if (request.kind === 'status') return shape({ protocol: value => value === 1, kind: value => value === 'status' })(request)
  if (['subscribe', 'unsubscribe', 'ack'].includes(request.kind)) return shape({ protocol: value => value === 1, kind: value => ['subscribe', 'unsubscribe', 'ack'].includes(value), subscriptionId: identifier, ...(request.kind === 'ack' ? { revision: value => Number.isSafeInteger(value) && value >= 0 } : {}) })(request)
  if (request.kind === 'cancel') return shape({ protocol: value => value === 1, kind: value => value === 'cancel', requestId: identifier })(request)
  const definitions = request.kind === 'read' ? read : request.kind === 'command' ? command : null
  if (!definitions || !own(definitions, request.operation)) return false
  const valid = shape({ protocol: value => value === 1, kind: value => value === request.kind, requestId: identifier, contextId: identifier, operation: shortText, input: definitions[request.operation], ...(request.kind === 'read' ? { source: value => ['snapshot', 'refresh'].includes(value) } : { operationId: identifier }) })
  try { return valid(request) } catch { return false }
}

module.exports = { validate, bounded, readOperations: Object.keys(read), commandOperations: Object.keys(command) }
