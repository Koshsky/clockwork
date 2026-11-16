import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !api || !['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('An explicit isolated loopback API is required')
const prefix = 'b19' + randomUUID().slice(0, 8), cleanup = [], report = []
const dates = { start_date: '2026-11-01', end_date: '2026-11-07' }
let token, savedConfig
async function request(method, route, body) {
  const response = await fetch(api + '/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, ...(response.status === 204 ? {} : await response.json()) }
}
async function call(method, route, body) {
  const response = await request(method, route, body)
  assert.ok(response.status >= 200 && response.status < 300, method + ' ' + route + ': ' + response.status + ' ' + response.error?.message)
  return response.data
}
async function create(route, body) {
  const response = await call('POST', route, body), id = response.user?.id ?? response.id
  cleanup.push(async () => { const result = await request('DELETE', route + '/' + id); assert.ok([200, 204, 404].includes(result.status)) })
  return response
}
const period = (start, end, capacity, unavailable) => ({ start_date: '2026-11-' + start, end_date: '2026-11-' + end, capacity, unavailable, available: capacity - unavailable })
const calendar = () => call('GET', '/timesheet/calendar?start_date=' + dates.start_date + '&end_date=' + dates.end_date)
try {
  const login = await call('POST', '/auth/login', { username: 'admin', password }); token = login.access_token
  savedConfig = await call('GET', '/auto-create/config')
  const employees = []
  for (let n = 0; n < 3; n++) {
    const account = await create('/user', { username: prefix + '_u' + n, first_name: 'Calendar', last_name: 'Fixture', preset: 'worker', ...(n === 1 ? { hire_date: '2026-11-03', termination_date: '2026-11-05' } : {}) })
    employees.push(account.user.id)
  }
  const resource = await create('/resources', { code: prefix, title: prefix, owner_id: login.user.id })
  const control = await create('/resources', { code: prefix + '-control', title: prefix + ' control', owner_id: login.user.id })
  const foreign = await create('/resources', { code: prefix + '-foreign', title: prefix + ' foreign', owner_id: employees[0] })
  for (const user_id of employees.slice(0, 2)) await call('POST', '/resources/' + resource.id + '/members', { user_id })
  await call('POST', '/resources/' + control.id + '/members', { user_id: employees[2] })
  const initial = await calendar()
  assert.deepEqual(initial.resources.find(row => row.resource_id === resource.id).periods, [period('01', '02', 1, 0), period('03', '05', 2, 0), period('06', '07', 1, 0)])
  const state = await create('/timesheet/states', { code: prefix, name: prefix, is_available: false })
  for (const [user, start, end] of [[employees[0], '02', '04'], [employees[1], '03', '05']]) {
    const route = '/user/' + user + '/days', range = { state_id: state.id, start_date: '2026-11-' + start, end_date: '2026-11-' + end }
    await call('PUT', route, range)
    cleanup.push(() => call('DELETE', route + '?' + new URLSearchParams(range)))
  }
  const absent = await calendar()
  assert.deepEqual(absent.resources.find(row => row.resource_id === resource.id).periods, [period('01', '01', 1, 0), period('02', '02', 1, 1), period('03', '04', 2, 2), period('05', '05', 2, 1), period('06', '07', 1, 0)])
  assert.deepEqual(absent.resources.find(row => row.resource_id === control.id), initial.resources.find(row => row.resource_id === control.id))
  report.push('Real SQL calendar preserves nullable/inclusive employment dates, overlapping absences and an unaffected resource')
  await call('DELETE', '/user/' + employees[1] + '/days?' + new URLSearchParams({ state_id: state.id, start_date: '2026-11-03', end_date: '2026-11-05' }))
  assert.deepEqual((await calendar()).resources.find(row => row.resource_id === resource.id).periods, [period('01', '01', 1, 0), period('02', '02', 1, 1), period('03', '04', 2, 1), period('05', '05', 2, 0), period('06', '07', 1, 0)])
  report.push('Removing one absence restores only its affected dates')

  const template = { enabled: true, processes: [{ title: prefix + '-process', owner_id: login.user.id, color: '#123456', tasks: [{ title: prefix + '-task', color: '#654321', resources: [{ resource_id: resource.id, quantity: 2 }], operations: [{ title: prefix + '-op1' }, { title: prefix + '-op2' }] }] }] }
  assert.deepEqual(await call('PUT', '/auto-create/config', template), template)
  assert.deepEqual(await call('GET', '/auto-create/config'), template)
  const project = await create('/project', { code: prefix, owner_id: login.user.id, ...dates })
  assert.deepEqual(project.auto_created, { processes: 1, tasks: 3, assignments: 1 })
  const planning = await call('GET', '/planning/tasks'), process = planning.processes.find(row => row.project_id === project.id)
  assert.equal(process.owner_id, login.user.id); assert.equal(process.color, '#123456'); assert.equal(process.tasks.length, 1)
  const task = process.tasks[0]
  assert.equal(task.color, '#654321'); assert.equal(task.resources[0].id, resource.id); assert.equal(task.resources[0].quantity, 2)
  assert.deepEqual(task.subtasks.map(row => row.title), [prefix + '-op1', prefix + '-op2'])
  for (const row of [task, ...task.subtasks]) { assert.equal(row.status, 'not_started'); assert.equal(row.start_date, dates.start_date); assert.equal(row.end_date, dates.end_date) }
  report.push('Template JSON round-trip and the real project trigger preserve processes, operations, resources, colors, dates and counts')
  const incompatible = structuredClone(template)
  incompatible.processes[0].tasks[0].resources[0].resource_id = foreign.id
  await call('PUT', '/auto-create/config', incompatible)
  const beforeFailure = await call('GET', '/planning/tasks')
  const failed = await request('POST', '/project', { code: prefix + '-rollback', owner_id: login.user.id, ...dates })
  assert.ok([400, 409, 422].includes(failed.status))
  assert.deepEqual(await call('GET', '/planning/tasks'), beforeFailure)
  report.push('A resource/process owner mismatch rolls back the entire trigger-created project tree')
  console.log(JSON.stringify({ cases: report.length, report }, null, 2))
} finally {
  const failures = []
  if (savedConfig) { try { await call('PUT', '/auto-create/config', savedConfig) } catch (error) { failures.push(error) } }
  for (const undo of cleanup.reverse()) { try { await undo() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Backend regression fixture cleanup failed')
}
