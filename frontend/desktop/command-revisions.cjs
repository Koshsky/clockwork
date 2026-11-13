'use strict'

function revisionsFor(input, caches) {
  const keys = new Set(), rows = [], tokens = new Map(), taskParents = new Map(), processParents = new Map(), milestoneParents = new Map()
  for (const cache of caches.values()) {
    for (const [key, token] of Object.entries(cache.revisions || {})) {
      if (!tokens.has(key)) tokens.set(key, new Set())
      tokens.get(key).add(token)
    }
    const assignParent = (map, id, parent) => {
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(parent)) return
      if (map.has(id) && map.get(id) !== parent) throw new Error('COMMAND_BASELINE_AMBIGUOUS')
      map.set(id, parent)
    }
    const walk = (value, kind = '') => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(part => walk(part, kind)); return }
      if (Number.isSafeInteger(value.id)) rows.push(value)
      if (['tasks', 'subtasks'].includes(kind)) assignParent(taskParents, value.id, value.process_id)
      if (kind === 'processes') assignParent(processParents, value.id, value.project_id)
      if (kind === 'milestones') assignParent(milestoneParents, value.id, value.process_id)
      if (kind === 'processes') {
        for (const task of value.tasks || []) {
          assignParent(taskParents, task.id, value.id)
          for (const subtask of task.subtasks || []) assignParent(taskParents, subtask.id, value.id)
        }
        for (const milestone of value.milestones || []) assignParent(milestoneParents, milestone.id, value.id)
      }
      for (const [key, part] of Object.entries(value)) if (part && typeof part === 'object') walk(part, key)
    }
    const data = cache.projection?.data?.data
    walk(data)
    const path = new URL(cache.key, 'https://cache.invalid').pathname
    if (/\/task(?:\/\d+)?$/.test(path)) for (const task of data?.items || (data?.id ? [data] : [])) assignParent(taskParents, task.id, task.process_id)
    if (/\/process(?:\/\d+)?$/.test(path)) for (const process of data?.items || (data?.id ? [data] : [])) assignParent(processParents, process.id, process.project_id)
    if (/\/milestone(?:\/\d+)?$/.test(path)) for (const milestone of data?.items || (data?.id ? [data] : [])) assignParent(milestoneParents, milestone.id, milestone.process_id)
  }
  const id = Number(input.path?.id), body = input.body || {}, route = input.route
  const add = (kind, value) => { if (Number.isSafeInteger(Number(value)) && Number(value) !== 0) keys.add(kind + ':' + Number(value)) }
  const taskProcess = taskId => taskParents.get(Number(taskId))
  const processProject = processId => processParents.get(Number(processId))
  const taskOf = taskId => { const process = taskProcess(taskId); if (process != null) add('process', process); else throw new Error('COMMAND_BASELINE_REQUIRED') }
  if (/^(PUT|DELETE) \/project\//.test(route)) add('project', id)
  else if (route === 'POST /process' || route === 'PUT /process/order') add('project', body.project_id)
  else if (/^(PUT|DELETE) \/process\//.test(route)) {
    add('process', id)
    if (body.project_id != null && body.project_id !== processProject(id)) add('project', body.project_id)
  } else if (route === 'PUT /task/order') add('process', body.process_id)
  else if (route === 'POST /task') { add('process', body.process_id); if (body.parent_id) taskOf(body.parent_id) }
  else if (/^(PUT|DELETE) \/task\//.test(route) || route === 'POST /task/{id}/dependencies') {
    taskOf(id); if (body.process_id) add('process', body.process_id)
    if (body.depends_on_task_id) taskOf(body.depends_on_task_id)
    if (body.parent_id) taskOf(body.parent_id)
  } else if (route.includes('/milestone')) {
    const old = milestoneParents.get(id)
    if (old) add('process', old)
    if (body.process_id) add('process', body.process_id)
    if (!keys.size) throw new Error('COMMAND_BASELINE_REQUIRED')
  } else if (route.includes('/assignment')) {
    if (body.task_id) taskOf(body.task_id)
    if (body.resource_id) add('resource', body.resource_id)
    if (id) {
      const assignment = rows.find(row => row.id === id && row.task_id && row.resource_id)
      if (assignment) { taskOf(assignment.task_id); add('resource', assignment.resource_id) }
      else {
        for (const task of rows.filter(row => Array.isArray(row.resources))) {
          for (const resource of task.resources) if (resource.assignment_id === id) { taskOf(task.id); add('resource', resource.id) }
        }
      }
    }
    if (!keys.size) throw new Error('COMMAND_BASELINE_REQUIRED')
  } else if (/^(PUT|DELETE|POST) \/resources\//.test(route)) add('resource', id)
  else if (route.includes('/timesheet/states')) keys.add('states')
  else if (route.includes('/days')) { add('user_days', id); keys.add('states') }
  const result = {}
  for (const key of keys) {
    if (tokens.get(key)?.size > 1) throw new Error('COMMAND_BASELINE_AMBIGUOUS')
    if (tokens.get(key)?.size) result[key] = [...tokens.get(key)][0]
    else if (Number(key.split(':')[1]) >= 0 || !key.includes(':')) throw new Error('COMMAND_BASELINE_REQUIRED')
    else result[key] = 'pending'
  }
  return result
}
module.exports = { revisionsFor }
