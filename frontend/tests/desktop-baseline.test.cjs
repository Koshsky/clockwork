'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { decorateSnapshot, stampOwnBaseline, applyOwnConfirmation } = require('../desktop/command-baseline.cjs')

function tree() {
  return { projects: [{ id: 1, project_code: 'Original', processes: [{ id: 1, project_id: 1, title: 'Process', tasks: [{ id: 1, process_id: 1, title: 'Task', subtasks: [{ id: 2, parent_id: 1, process_id: 1, title: 'Subtask' }], resources: [{ id: 3, assignment_id: 1, quantity: 4 }] }], milestones: [{ id: 1, date: '2026-11-13', title: 'Milestone' }], dependencies: [{ id: 1, task_id: 1, depends_on_task_id: 2, type: 'fs' }] }] }] }
}
const tokens = { 'project:1': 'project-old', 'process:1': 'process-old', 'resource:3': 'resource-old', 'resource:9': 'unrelated', states: 'states-old' }

function processOf(snapshot) { return snapshot.projects[0].processes[0] }
function taskOf(snapshot) { return processOf(snapshot).tasks[0] }

test('planning rows receive minimal tokens from the same snapshot without changing the input', () => {
  const input = tree(), original = structuredClone(input)
  const output = decorateSnapshot(input, tokens, 'GET /planning/processes')
  assert.deepEqual(input, original)
  assert.notEqual(output, input)
  assert.deepEqual(output.projects[0]._baseline, { 'project:1': 'project-old' })
  assert.deepEqual(processOf(output)._baseline, { 'process:1': 'process-old' })
  assert.deepEqual(taskOf(output)._baseline, { 'process:1': 'process-old' })
  assert.deepEqual(taskOf(output).subtasks[0]._baseline, { 'process:1': 'process-old' })
  assert.deepEqual(processOf(output).milestones[0]._baseline, { 'process:1': 'process-old' })
  assert.deepEqual(processOf(output).dependencies[0]._baseline, { 'process:1': 'process-old' })
  assert.deepEqual(taskOf(output).resources[0]._baseline, { 'process:1': 'process-old', 'resource:3': 'resource-old' })
  assert.ok(Object.keys(taskOf(output)).includes('_baseline'))
  assert.deepEqual(JSON.parse(JSON.stringify(output)), output)
})

test('planning task aggregates infer process context for children without process_id', () => {
  const output = decorateSnapshot({ processes: [{ id: 5, tasks: [{ id: 6, title: 'Task', subtasks: [{ id: 7 }] }], milestones: [{ id: 8, date: '2026-11-13' }] }] }, { 'process:5': 'p5', 'process:99': 'foreign' }, 'GET /planning/tasks')
  assert.deepEqual(output.processes[0].tasks[0].subtasks[0]._baseline, { 'process:5': 'p5' })
  assert.deepEqual(output.processes[0].milestones[0]._baseline, { 'process:5': 'p5' })
})

test('direct cards and paginated lists keep their original shapes', () => {
  const card = decorateSnapshot({ id: 1, title: 'Task', process_id: 5 }, { 'process:5': 'p5' }, 'GET /task/{id}')
  assert.deepEqual(card, { id: 1, title: 'Task', process_id: 5, _baseline: { 'process:5': 'p5' } })
  const page = decorateSnapshot({ items: [{ id: 2, project_id: 3 }], total: 1, offset: 0 }, { 'process:2': 'p2', 'project:3': 'pr3' }, 'GET /process')
  assert.equal(page.total, 1)
  assert.equal(page.offset, 0)
  assert.deepEqual(page.items[0]._baseline, { 'process:2': 'p2' })
  assert.equal(Object.hasOwn(page, '_baseline'), false)
})

test('absolute URLs and source API prefixes are supported', () => {
  const row = decorateSnapshot({ id: 3 }, { 'resource:3': 'r3' }, 'https://example.test/api/v1/resources/3?limit=5')
  assert.deepEqual(row._baseline, { 'resource:3': 'r3' })
})

test('a row stamped by its own acknowledgement retains that exact baseline', () => {
  const input = tree()
  taskOf(input)._baseline = { 'process:1': 'own-new' }
  const result = decorateSnapshot(input, tokens, 'GET /planning/processes')
  assert.deepEqual(taskOf(result)._baseline, { 'process:1': 'own-new' })
  assert.deepEqual(processOf(result)._baseline, { 'process:1': 'process-old' })
  assert.deepEqual(taskOf(result).subtasks[0]._baseline, { 'process:1': 'process-old' })
  assert.notEqual(taskOf(result)._baseline, taskOf(input)._baseline)
})

test('missing positive tokens stay explicit and do not borrow another aggregate token', () => {
  const output = decorateSnapshot({ id: 1, process_id: 2 }, { 'process:3': 'other' }, 'GET /task/{id}')
  assert.deepEqual(output._baseline, {})
})

test('negative local aggregates have placeholders that require creator acknowledgement', () => {
  const output = decorateSnapshot({ processes: [{ id: -1, tasks: [{ id: -2, process_id: -1, resources: [{ id: -3, assignment_id: -4 }] }] }] }, {}, 'GET /planning/tasks')
  assert.deepEqual(output.processes[0]._baseline, { 'process:-1': 'pending' })
  assert.deepEqual(output.processes[0].tasks[0]._baseline, { 'process:-1': 'pending' })
  assert.deepEqual(output.processes[0].tasks[0].resources[0]._baseline, { 'process:-1': 'pending', 'resource:-3': 'pending' })
})

test('direct assignment rows retain only their own resource plus atomic process candidates', () => {
  const result = decorateSnapshot({ items: [{ id: 1, task_id: 2, resource_id: 3 }] }, { 'process:5': 'p5', 'process:6': 'p6', 'resource:3': 'r3', 'resource:9': 'foreign', states: 's' }, 'GET /assignment')
  assert.deepEqual(result.items[0]._baseline, { 'process:5': 'p5', 'process:6': 'p6', 'resource:3': 'r3' })
})

test('a direct assignment with known process uses exactly that process', () => {
  const result = decorateSnapshot({ id: 1, task_id: 2, resource_id: 3, process_id: 5 }, { 'process:5': 'p5', 'process:6': 'p6', 'resource:3': 'r3' }, 'GET /assignment/{id}')
  assert.deepEqual(result._baseline, { 'process:5': 'p5', 'resource:3': 'r3' })
})

test('state arrays keep state-only baselines', () => {
  const result = decorateSnapshot([{ id: 1, code: 'A', name: 'Available', is_available: true }], tokens, 'GET /timesheet/states')
  assert.ok(Array.isArray(result))
  assert.deepEqual(result[0]._baseline, { states: 'states-old' })
})

test('user day batches bind even empty user wrappers and inherit the correct user context', () => {
  const input = [{ user_id: 7, days: [] }, { user_id: 8, days: [{ id: 7, state_id: 1 }] }]
  const output = decorateSnapshot(input, { 'user_days:7': 'u7', 'user_days:8': 'u8', states: 's' }, 'GET /user/days')
  assert.deepEqual(output[0]._baseline, { 'user_days:7': 'u7', states: 's' })
  assert.deepEqual(output[1]._baseline, { 'user_days:8': 'u8', states: 's' })
  assert.deepEqual(output[1].days[0]._baseline, { 'user_days:8': 'u8', states: 's' })
  assert.deepEqual(input[0], { user_id: 7, days: [] })
})

test('single worker periods use URL context and preserve an empty array', () => {
  const revisions = { 'user_days:7': 'u7', 'user_days:8': 'u8', states: 's' }
  const output = decorateSnapshot([{ id: 1, state_id: 3 }], revisions, 'GET /user/7/days')
  assert.deepEqual(output[0]._baseline, { 'user_days:7': 'u7', states: 's' })
  const empty = decorateSnapshot([], revisions, 'GET /user/7/days')
  assert.deepEqual(empty, [])
  assert.equal(Object.hasOwn(empty, '_baseline'), false)
})

test('single worker template routes infer only an unambiguous user token', () => {
  const result = decorateSnapshot([{ id: 1, state_id: 3 }], { 'user_days:7': 'u7', states: 's' }, 'GET /user/{id}/days')
  assert.deepEqual(result[0]._baseline, { 'user_days:7': 'u7', states: 's' })
})

test('calendar records receive only the resource token', () => {
  const result = decorateSnapshot({ resources: [{ resource_id: 3, periods: [{ capacity: 2 }] }] }, tokens, 'GET /timesheet/calendar')
  assert.deepEqual(result.resources[0]._baseline, { 'resource:3': 'resource-old' })
  assert.equal(Object.hasOwn(result.resources[0].periods[0], '_baseline'), false)
})

test('user information, resource members and comments receive no tokens', () => {
  for (const route of ['GET /user', 'GET /user/all', 'GET /user/{id}', 'GET /resources/{id}/members', 'GET /task/{id}/comments']) {
    const data = { items: [{ id: 1, name: 'Person', username: 'user', code: 'Text', title: 'Comment' }] }
    assert.deepEqual(decorateSnapshot(data, tokens, route), data)
  }
})

test('own task acknowledgement changes only that task despite equal IDs across types', () => {
  const input = decorateSnapshot(tree(), tokens, 'GET /planning/processes')
  const before = structuredClone(input)
  assert.equal(stampOwnBaseline(input, { 'project:1': 'new-project', 'process:1': 'new-process', 'resource:3': 'new-resource' }, 'PUT /task/{id}', 1), input)
  assert.deepEqual(taskOf(input)._baseline, { 'process:1': 'new-process' })
  assert.deepEqual(input.projects[0]._baseline, before.projects[0]._baseline)
  assert.deepEqual(processOf(input)._baseline, before.projects[0].processes[0]._baseline)
  assert.deepEqual(taskOf(input).subtasks[0]._baseline, taskOf(before).subtasks[0]._baseline)
  assert.deepEqual(processOf(input).milestones[0]._baseline, processOf(before).milestones[0]._baseline)
  assert.deepEqual(taskOf(input).resources[0]._baseline, taskOf(before).resources[0]._baseline)
})

test('project and process acknowledgements never lend new tokens to cascading children', () => {
  const input = decorateSnapshot(tree(), tokens, 'GET /planning/processes')
  stampOwnBaseline(input, { 'project:1': 'new-project', 'process:1': 'new-process' }, 'PUT /project/{id}', 1)
  assert.deepEqual(input.projects[0]._baseline, { 'project:1': 'new-project' })
  assert.deepEqual(processOf(input)._baseline, { 'process:1': 'process-old' })
  stampOwnBaseline(input, { 'process:1': 'new-process' }, 'PUT /process/{id}', 1)
  assert.deepEqual(processOf(input)._baseline, { 'process:1': 'new-process' })
  assert.deepEqual(taskOf(input)._baseline, { 'process:1': 'process-old' })
})

test('assignment acknowledgement matches assignment_id rather than the resource ID', () => {
  const input = decorateSnapshot(tree(), tokens, 'GET /planning/processes')
  stampOwnBaseline(input, { 'process:1': 'new-process', 'resource:3': 'new-resource' }, 'PUT /assignment/{id}', 1)
  assert.deepEqual(taskOf(input).resources[0]._baseline, { 'process:1': 'new-process', 'resource:3': 'new-resource' })
  assert.deepEqual(taskOf(input)._baseline, { 'process:1': 'process-old' })
})

test('resource acknowledgement does not stamp stale planning badge copies', () => {
  const input = decorateSnapshot(tree(), tokens, 'GET /planning/processes'), before = structuredClone(input)
  stampOwnBaseline(input, { 'resource:3': 'new-resource' }, 'PUT /resources/{id}', 3)
  assert.deepEqual(input, before)
})

test('incomplete acknowledgement metadata does not destroy a valid row baseline', () => {
  const input = decorateSnapshot({ id: 1, process_id: 2 }, { 'process:2': 'old' }, 'GET /task/{id}')
  stampOwnBaseline(input, { 'process:3': 'unrelated' }, 'PUT /task/{id}', 1)
  assert.deepEqual(input._baseline, { 'process:2': 'old' })
})

test('full own DTO updates direct cards before stamping their baseline', () => {
  const input = { id: 1, title: 'old', process_id: 2, _baseline: { 'process:2': 'old' } }
  const dto = { id: 1, title: 'new', process_id: 2, owner_id: 7 }
  assert.equal(applyOwnConfirmation(input, { 'process:2': 'new-token' }, 'PUT /task/{id}', dto, 'GET /task/{id}'), input)
  assert.deepEqual(input, { ...dto, _baseline: { 'process:2': 'new-token' } })
})

test('full own DTO updates paginated rows and leaves siblings unchanged', () => {
  const input = { items: [{ id: 1, title: 'old', process_id: 2 }, { id: 2, title: 'sibling', process_id: 2 }], total: 2 }
  applyOwnConfirmation(input, { 'process:2': 'new-token' }, 'PUT /task/{id}', { id: 1, process_id: 2, title: 'new' }, 'GET /task')
  assert.deepEqual(input.items[0]._baseline, { 'process:2': 'new-token' })
  assert.equal(input.items[0].title, 'new')
  assert.equal(Object.hasOwn(input.items[1], '_baseline'), false)
})

test('planning project DTO aliases code without advancing its processes', () => {
  const input = tree()
  applyOwnConfirmation(input, { 'project:1': 'new-project' }, 'PUT /project/{id}', { id: 1, code: 'Updated' }, 'GET /planning/processes')
  assert.equal(input.projects[0].project_code, 'Updated')
  assert.deepEqual(input.projects[0]._baseline, { 'project:1': 'new-project' })
  assert.equal(Object.hasOwn(processOf(input), '_baseline'), false)
})

test('assignment DTO updates a badge without confusing resource ID and assignment ID', () => {
  const input = tree()
  applyOwnConfirmation(input, { 'process:1': 'p-new', 'resource:8': 'r-new' }, 'PUT /assignment/{id}', { id: 1, task_id: 1, resource_id: 8, quantity: 6 }, 'GET /planning/processes')
  const badge = taskOf(input).resources[0]
  assert.equal(badge.id, 8)
  assert.equal(badge.assignment_id, 1)
  assert.equal(badge.quantity, 6)
  assert.deepEqual(badge._baseline, { 'process:1': 'p-new', 'resource:8': 'r-new' })
})

test('source route excludes users even if a row resembles another DTO family', () => {
  const input = { items: [{ id: 1, title: 'Position', code: 'staff' }] }, before = structuredClone(input)
  applyOwnConfirmation(input, { 'resource:1': 'new' }, 'PUT /resources/{id}', { id: 1, title: 'Resource', code: 'R' }, 'GET /user')
  assert.deepEqual(input, before)
})

test('delete acknowledgement does not decorate a stale direct card', () => {
  const input = { id: 1, process_id: 2, title: 'Deleted task' }, before = structuredClone(input)
  applyOwnConfirmation(input, { 'process:2': 'new-token' }, 'DELETE /task/{id}', {}, 'GET /task/{id}')
  assert.deepEqual(input, before)
})

test('local resource header arrays use the same source-bound resource markers', () => {
  const input = [{ id: 3, title: 'Resource', code: 'R' }]
  const decorated = decorateSnapshot(input, tokens, '/local/resource-header?owner_id=all')
  assert.deepEqual(decorated[0]._baseline, { 'resource:3': 'resource-old' })
  applyOwnConfirmation(decorated, { 'resource:3': 'new' }, 'PUT /resources/{id}', { id: 3, title: 'Changed', code: 'R' }, '/local/resource-header?owner_id=all')
  assert.equal(decorated[0].title, 'Changed')
  assert.deepEqual(decorated[0]._baseline, { 'resource:3': 'new' })
})

test('null and primitive snapshots remain usable without a browser or native service', () => {
  for (const input of [null, undefined, false, 1, 'text']) assert.equal(decorateSnapshot(input, tokens, 'GET /task'), input)
})

test('the module loads in a sandbox without require, process, Vue or a native service', () => {
  const { readFileSync } = require('node:fs')
  const { runInNewContext } = require('node:vm')
  const source = readFileSync(require.resolve('../desktop/command-baseline.cjs'), 'utf8')
  const sandbox = { module: { exports: {} }, structuredClone, URL }
  runInNewContext(source, sandbox)
  const value = sandbox.module.exports.decorateSnapshot({ id: 1, process_id: 2 }, { 'process:2': 'p' }, 'GET /task/{id}')
  assert.equal(JSON.stringify(value), JSON.stringify({ id: 1, process_id: 2, _baseline: { 'process:2': 'p' } }))
})

test('a process carrying derived project_code is still a process for acknowledgement stamping', () => {
  const row = { id: 1, project_id: 2, project_code: 'P2', title: 'Process', _baseline: { 'process:1': 'old' } }
  stampOwnBaseline(row, { 'process:1': 'new', 'project:1': 'unrelated' }, 'PUT /project/{id}', 1)
  assert.deepEqual(row._baseline, { 'process:1': 'old' })
  stampOwnBaseline(row, { 'process:1': 'new' }, 'PUT /process/{id}', 1)
  assert.deepEqual(row._baseline, { 'process:1': 'new' })
})

test('a full acknowledged DTO clears only its own aggregate pending metadata', () => {
  const snapshot = { processes: [{ id: 10, tasks: [{ id: 30, title: 'Old', _baseline: { 'process:10': 'old' }, _pending: { 'process:10': 'own', 'resource:40': 'other' } }] }] }
  applyOwnConfirmation(snapshot, { 'process:10': 'new' }, 'PUT /task/{id}', { id: 30, process_id: 10, title: 'New' }, '/planning/tasks')
  assert.deepEqual(snapshot.processes[0].tasks[0]._pending, { 'resource:40': 'other' })
})
