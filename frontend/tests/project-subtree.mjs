import { request, expect } from 'playwright/test'
import fs from 'node:fs'

const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]
}))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'project-subtree-' + Date.now()
const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const fixtures = [], failures = []
let userID
async function call(token, method, path, data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (response.status() === 429) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(response.headers()['retry-after']) || 1) * 1000))
      continue
    }
    const text = await response.text(), body = text ? JSON.parse(text) : {}
    return { status: response.status(), data: body.data, error: body.error }
  }
  throw new Error('Local API remained rate limited after five attempts')
}
await expect.poll(async () => {
  try { return (await http.get('health')).status() } catch { return 0 }
}, { timeout: 20_000 }).toBe(200)
const login = await call(null, 'POST', 'auth/login', { username: 'admin', password: env.ADMIN_PASSWORD })
expect(login.status).toBe(200)
const admin = login.data.access_token, foreignID = login.data.user.id
async function create(path, body) {
  const result = await call(admin, 'POST', path, body)
  expect(result.status, path + ': ' + JSON.stringify(result.error)).toBe(201)
  return result.data.id
}
function equal(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(name + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected))
}
try {
  const username = 'subtree' + Date.now().toString().slice(-9)
  const user = await call(admin, 'POST', 'user', {
    username, first_name: 'Subtree', last_name: 'Test', preset: 'worker',
    permissions: ['view', 'update', 'delete'].map((action) => ({ resource: 'project', action, scope: 'down', granted: true })).concat(['process', 'task'].map((resource) => ({ resource, action: 'view', scope: 'all', granted: true }))),
  })
  expect(user.status).toBe(201);userID = user.data.user.id
  const auth = await call(null, 'POST', 'auth/login', { username, password: user.data.password })
  expect(auth.status).toBe(200)
  const token = auth.data.access_token
  for (const [name, processOwn, taskOwn, subtaskOwn, visible, projectOwn] of [
    ['own-empty-process', true, null, false, true, false],
    ['own-process-foreign-tasks', true, false, false, true, false],
    ['own-task-foreign-process', false, true, false, true, false],
    ['own-subtask-only', false, false, true, true, false],
    ['own-process-and-task', true, true, false, true, false],
    ['foreign-only', false, false, false, false, false],
    ['empty-foreign-project', null, null, false, false, false],
    ['empty-own-project-with-down-only', null, null, false, false, true],
  ]) {
    const id = await create('project', { ...dates, code: prefix + '-' + name, owner_id: projectOwn ? userID : foreignID })
    const fixture = { id, name, visible, children: [] };fixtures.push(fixture)
    if (processOwn === null) continue
    const process = await create('process', { ...dates, project_id: id, title: prefix + '-' + name, owner_id: processOwn ? userID : foreignID })
    fixture.children.push(['process', process])
    if (taskOwn === null) continue
    const task = await create('task', { ...dates, process_id: process, title: prefix + '-' + name, owner_id: taskOwn ? userID : foreignID })
    fixture.children.push(['task', task])
    if (subtaskOwn) fixture.children.push(['task', await create('task', { process_id: process, parent_id: task, title: prefix + '-subtask', owner_id: userID })])
    if (name === 'own-process-and-task') {
      fixture.children.push(['task', await create('task', { ...dates, process_id: process, title: prefix + '-second-owned-task', owner_id: userID })])
      fixture.children.push(['process', await create('process', { ...dates, project_id: id, title: prefix + '-second-owned-process', owner_id: userID })])
    }
  }
  const expectedIDs = () => fixtures.filter((f) => f.visible).map((f) => f.id).sort((a, b) => a - b)
  const checkCollections = async (stage) => {
    const ids = []
    for (let offset = 0; ; offset++) {
      const list = await call(token, 'GET', 'project?limit=1&offset=' + offset)
      expect(list.status).toBe(200)
      equal(list.data.total, expectedIDs().length, stage + ' list total')
      ids.push(...list.data.items.map((p) => p.id))
      if (list.data.items.length === 0) break
    }
    equal(ids.sort((a, b) => a - b), expectedIDs(), stage + ' paginated project list')
    equal(new Set(ids).size, ids.length, stage + ' no duplicate projects')
    const planning = await call(token, 'GET', 'planning/projects')
    expect(planning.status).toBe(200)
    equal(planning.data.projects.map((p) => p.id).sort((a, b) => a - b), expectedIDs(), stage + ' project diagram')
    const processPlanning = await call(token, 'GET', 'planning/processes')
    expect(processPlanning.status).toBe(200)
    equal(processPlanning.data.projects.map((p) => p.id).sort((a, b) => a - b), expectedIDs(), stage + ' parent projects in process diagram')
  }
  await checkCollections('initial')
  for (const fixture of fixtures) {
    const read = await call(token, 'GET', 'project/' + fixture.id)
    equal(read.status, fixture.visible ? 200 : 404, fixture.name + ' GET')
    if (read.status === 200) expect(read.data.id).toBe(fixture.id)
    else expect(read.data ?? {}).toEqual({})
  }

  const changing = fixtures[0], processID = changing.children[0][1]
  expect((await call(admin, 'PUT', 'process/' + processID, { owner_id: foreignID })).status).toBe(200)
  changing.visible = false
  await checkCollections('after losing the only owned process')
  equal((await call(token, 'GET', 'project/' + changing.id)).status, 404, 'lost descendant GET')
  const before = await call(admin, 'GET', 'project/' + changing.id)
  expect((await call(token, 'PUT', 'project/' + changing.id, { code: prefix + '-forbidden' })).status).toBe(403)
  expect((await call(token, 'DELETE', 'project/' + changing.id)).status).toBe(403)
  expect((await call(admin, 'GET', 'project/' + changing.id)).data).toEqual(before.data)
  expect((await call(admin, 'PUT', 'process/' + processID, { owner_id: userID })).status).toBe(200)
  changing.visible = true
  await checkCollections('after restoring owned process')

  const taskChanging = fixtures[2], taskID = taskChanging.children.find(([kind]) => kind === 'task')[1]
  expect((await call(admin, 'PUT', 'task/' + taskID, { owner_id: foreignID })).status).toBe(200)
  taskChanging.visible = false
  await checkCollections('after losing the only owned task')
  expect((await call(token, 'GET', 'project/' + taskChanging.id)).status).toBe(404)
  const taskProjectBefore = await call(admin, 'GET', 'project/' + taskChanging.id)
  expect((await call(token, 'PUT', 'project/' + taskChanging.id, { code: prefix + '-forbidden-task' })).status).toBe(403)
  expect((await call(token, 'DELETE', 'project/' + taskChanging.id)).status).toBe(403)
  expect((await call(admin, 'GET', 'project/' + taskChanging.id)).data).toEqual(taskProjectBefore.data)
  expect((await call(admin, 'PUT', 'task/' + taskID, { owner_id: userID })).status).toBe(200)
  taskChanging.visible = true
  await checkCollections('after restoring owned task')

  for (const fixture of fixtures) {
    const path = 'project/' + fixture.id
    const before = await call(admin, 'GET', path)
    const code = prefix + '-edited-' + fixture.id
    const updated = await call(token, 'PUT', path, { code })
    equal(updated.status, fixture.visible ? 200 : 403, fixture.name + ' PUT')
    if (updated.status === 200) expect((await call(admin, 'GET', path)).data.code).toBe(code)
    else expect((await call(admin, 'GET', path)).data).toEqual(before.data)
    const removed = await call(token, 'DELETE', path)
    equal(removed.status, fixture.visible ? 204 : 403, fixture.name + ' DELETE')
    const saved = await call(admin, 'GET', path)
    if (removed.status === 204) {
      expect(saved.status).toBe(404)
      for (const [kind, id] of fixture.children) expect((await call(admin, 'GET', kind + '/' + id)).status).toBe(404)
    } else expect(saved.data).toEqual(before.data)
    console.log((fixture.visible ? 'CHECK allowed ' : 'PASS denied ') + fixture.name + ': GET/PUT/DELETE')
  }
  expect(failures, failures.join('\n')).toEqual([])
  console.log('PASS project subtree: own processes OR own tasks/subtasks; list/count/pagination, diagram, direct GET/PUT/DELETE, dynamic ownership and denied writes without changes')
} finally {
  for (const fixture of fixtures) await call(admin, 'DELETE', 'project/' + fixture.id)
  if (userID) await call(admin, 'DELETE', 'user/' + userID)
  await http.dispose()
}
