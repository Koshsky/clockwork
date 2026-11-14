'use strict'

const object = value => value != null && typeof value === 'object' && !Array.isArray(value)
const numberId = value => Number.isSafeInteger(value) && value !== 0 ? value : null
const aggregate = (kind, id) => numberId(id) == null ? null : kind + ':' + id

function pathOf(route) {
  const value = String(route || '').trim().replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '')
  try { return new URL(value, 'https://baseline.invalid').pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/^\/api\/v1(?=\/|$)/, '') }
  catch { return '' }
}

function kindOf(route) {
  const path = pathOf(route)
  if (path === '/planning/projects' || path === '/planning/processes') return 'project'
  if (path === '/planning/tasks') return 'process'
  if (path === '/timesheet/calendar') return 'calendar'
  if (path === '/local/resource-header') return 'resource'
  if (/^\/user\/(?:\{id\}|:id|\d+|days)\/days$/.test(path) || path === '/user/days') return 'userDays'
  if (/^\/resources\/[^/]+\/(?:members|absence)(?:\/|$)/.test(path)) return 'excluded'
  if (/^\/timesheet\/states(?:\/|$)/.test(path)) return 'state'
  if (/^\/task\/[^/]+\/dependencies(?:\/|$)/.test(path)) return 'dependency'
  if (/^\/(?:task|process)\/order$/.test(path)) return 'excluded'
  const family = /^\/(project|process|task|milestone|assignment|resources)(?:\/[^/]+)?$/.exec(path)?.[1]
  return family === 'resources' ? 'resource' : family || 'excluded'
}

function inferredKind(row) {
  if ('task_id' in row && 'resource_id' in row) return 'assignment'
  if ('task_id' in row && 'depends_on_task_id' in row) return 'dependency'
  if ('date' in row && 'title' in row) return 'milestone'
  if ('process_id' in row) return 'task'
  if ('project_id' in row || 'tasks' in row || 'milestones' in row) return 'process'
  if ('project_code' in row || 'processes' in row || 'code' in row && 'priority' in row) return 'project'
  if ('is_available' in row && 'code' in row && 'name' in row) return 'state'
  if ('code' in row && 'title' in row && !('assignment_id' in row)) return 'resource'
  if ('user_id' in row && Array.isArray(row.days)) return 'userDays'
  return ''
}

function processKeys(revisions, processId) {
  const key = aggregate('process', processId)
  return key ? [key] : Object.keys(revisions).filter(value => /^process:[1-9]\d*$/.test(value))
}

function rowKeys(kind, row, context, revisions) {
  switch (kind) {
    case 'project': return [aggregate('project', row.id)].filter(Boolean)
    case 'process': return [aggregate('process', row.id)].filter(Boolean)
    case 'resource': return [aggregate('resource', row.id)].filter(Boolean)
    case 'task': case 'milestone': case 'dependency': return processKeys(revisions, context.processId)
    case 'assignment': case 'badge':
      return [...processKeys(revisions, context.processId), aggregate('resource', kind === 'badge' ? row.id : row.resource_id)].filter(Boolean)
    case 'state': return ['states']
    case 'userDays': case 'period': return [aggregate('user_days', context.userId), 'states'].filter(Boolean)
    case 'calendarResource': return [aggregate('resource', row.resource_id)].filter(Boolean)
    default: return []
  }
}

function contextOf(row, kind, parent) {
  return {
    processId: kind === 'process' ? row.id : numberId(row.process_id) ?? parent.processId,
    taskId: kind === 'task' ? row.id : parent.taskId,
    userId: kind === 'userDays' ? numberId(row.user_id) ?? parent.userId : parent.userId,
  }
}

function walk(value, kind, parent, visitor) {
  if (Array.isArray(value)) { value.forEach(row => walk(row, kind === 'userDays' && !Array.isArray(row?.days) ? 'period' : kind, parent, visitor)); return }
  if (!object(value)) return
  const actualKind = kind === 'auto' ? inferredKind(value) : kind
  const context = contextOf(value, actualKind, parent)
  if (numberId(value.id) != null || actualKind === 'userDays' && numberId(value.user_id) != null || actualKind === 'calendarResource' && numberId(value.resource_id) != null) visitor(value, actualKind, context)
  for (const [key, child] of Object.entries(value)) {
    if (key === '_baseline') continue
    let childKind = { projects: 'project', processes: 'process', tasks: 'task', subtasks: 'task', milestones: 'milestone', dependencies: 'dependency' }[key]
    if (key === 'resources') childKind = actualKind === 'task' ? 'badge' : actualKind === 'calendar' ? 'calendarResource' : 'resource'
    if (key === 'days' && actualKind === 'userDays') childKind = 'period'
    if (key === 'items' || key === 'data') childKind = actualKind || 'auto'
    if (childKind) walk(child, childKind, context, visitor)
  }
}

function initialContext(snapshot, revisions, route) {
  const pathUser = /^\/user\/(-?\d+)\/days$/.exec(pathOf(route))
  const keys = Object.keys(revisions).filter(key => /^user_days:[1-9]\d*$/.test(key))
  return { userId: pathUser ? Number(pathUser[1]) : keys.length === 1 ? Number(keys[0].split(':')[1]) : undefined }
}

function selectedTokens(keys, revisions) {
  const result = {}
  for (const key of keys) {
    if (typeof revisions[key] === 'string' && revisions[key]) result[key] = revisions[key]
    else if (/^[a-z_]+:-[1-9]\d*$/.test(key)) result[key] = 'pending'
  }
  return result
}

// A row may already carry an authoritative own acknowledgement while the rest of its snapshot is older.
function decorateSnapshot(snapshot, revisions = {}, route) {
  const result = structuredClone(snapshot), kind = kindOf(route)
  if (kind === 'excluded') return result
  const visit = (row, rowKind, context) => {
    if (object(row._baseline)) return
    row._baseline = selectedTokens(rowKeys(rowKind, row, context, revisions), revisions)
  }
  walk(result, kind, initialContext(result, revisions, route), visit)
  return result
}

function matchesTarget(row, rowKind, target, id) {
  return target === 'assignment' && rowKind === 'badge' ? row.assignment_id === id : rowKind === target && row.id === id
}

function stamp(row, rowKind, context, revisions) {
  const keys = rowKeys(rowKind, row, context, revisions), tokens = selectedTokens(keys, revisions)
  if (keys.length && keys.every(key => Object.hasOwn(tokens, key))) {
    row._baseline = tokens
    if (object(row._pending)) { for (const key of keys) delete row._pending[key]; if (!Object.keys(row._pending).length) delete row._pending }
  }
}

// The caller must apply the full acknowledged DTO before advancing a row; derived children keep their old baseline.
function stampOwnBaseline(snapshot, revisions = {}, route, id) {
  const target = kindOf(route)
  if (!['project', 'process', 'task', 'milestone', 'assignment', 'resource', 'state', 'dependency'].includes(target)) return snapshot
  walk(snapshot, 'auto', {}, (row, rowKind, context) => {
    if (matchesTarget(row, rowKind, target, id)) stamp(row, rowKind, context, revisions)
  })
  return snapshot
}

// Source route prevents an identical ID in a different DTO family from receiving another object's token.
function applyOwnConfirmation(snapshot, revisions = {}, route, dto, sourceRoute) {
  if (/^DELETE\s/.test(String(route))) return snapshot
  const target = kindOf(route), source = sourceRoute ? kindOf(sourceRoute) : 'auto'
  if (!object(dto) || numberId(dto.id) == null || source === 'excluded' || !['project', 'process', 'task', 'milestone', 'assignment', 'resource', 'state', 'dependency'].includes(target)) return snapshot
  walk(snapshot, source, {}, (row, rowKind, context) => {
    if (!matchesTarget(row, rowKind, target, dto.id)) return
    if (rowKind === 'badge') {
      if (context.taskId != null && context.taskId !== dto.task_id) return
      Object.assign(row, { id: dto.resource_id, assignment_id: dto.id, quantity: dto.quantity })
    } else {
      const projectCode = rowKind === 'project' && Object.hasOwn(row, 'project_code')
      Object.assign(row, dto)
      if (projectCode && Object.hasOwn(dto, 'code')) row.project_code = dto.code
    }
    stamp(row, rowKind, contextOf(row, rowKind, context), revisions)
  })
  return snapshot
}

module.exports = { decorateSnapshot, stampOwnBaseline, applyOwnConfirmation }
