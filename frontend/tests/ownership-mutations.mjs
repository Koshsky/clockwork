import { request, expect } from 'playwright/test'
import fs from 'node:fs'

const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]
}))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'ownership-mutations-' + Date.now()
const users = [], projects = [], resources = [], failures = []
const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
async function call(token, method, path, data) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (response.status() === 429) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(response.headers()['retry-after']) || 1) * 1000))
      continue
    }
    const text = await response.text()
    const body = text ? JSON.parse(text) : {}
    return { status: response.status(), data: body.data, error: body.error }
  }
  throw new Error('Local API remained rate limited after five attempts')
}
const login = await call(null, 'POST', 'auth/login', { username: 'admin', password: env.ADMIN_PASSWORD })
expect(login.status).toBe(200)
const admin = login.data.access_token
async function create(path, data) {
  const result = await call(admin, 'POST', path, data)
  expect(result.status, path + ' fixture: ' + JSON.stringify(result.error)).toBe(201)
  if (path === 'project') projects.push(result.data.id)
  if (path === 'resources') resources.push(result.data.id)
  return result.data.id
}
async function user(scope) {
  const permissions = ['project', 'process', 'task', 'milestone', 'assignment'].flatMap((resource) => ['view', 'update', 'delete'].map((action) => ({ resource, action, scope: scope === 'all' || action === 'view' ? 'all' : resource === 'project' ? 'self' : 'up1', granted: true })))
  const username = 'mut' + Date.now().toString().slice(-9) + scope
  const result = await call(admin, 'POST', 'user', { username, first_name: 'Mutation', last_name: 'Test', preset: 'worker', permissions })
  expect(result.status).toBe(201)
  users.push(result.data.user.id)
  const auth = await call(null, 'POST', 'auth/login', { username, password: result.data.password })
  expect(auth.status).toBe(200)
  return { id: result.data.user.id, token: auth.data.access_token }
}
try {
  const own = await user('self'), all = await user('all')
  const ownProject = await create('project', { ...dates, owner_id: own.id, code: prefix + '-own' })
  const foreignProject = await create('project', { ...dates, owner_id: all.id, code: prefix + '-foreign' })
  await create('process', { ...dates, project_id: ownProject, owner_id: own.id, title: prefix + '-position-fixture' })
  const ownProcess = await create('process', { ...dates, project_id: ownProject, owner_id: own.id, title: prefix + '-own' })
  const foreignProcess = await create('process', { ...dates, project_id: foreignProject, owner_id: all.id, title: prefix + '-foreign' })
  const ownTask = await create('task', { ...dates, process_id: ownProcess, owner_id: own.id, title: prefix + '-own' })
  const foreignTask = await create('task', { ...dates, process_id: foreignProcess, owner_id: own.id, title: prefix + '-foreign' })
  const ownTaskInForeignProcess = await create('task', { ...dates, process_id: foreignProcess, owner_id: own.id, title: prefix + '-own-in-foreign-process' })
  const foreignTaskInOwnProcess = await create('task', { ...dates, process_id: ownProcess, owner_id: all.id, title: prefix + '-foreign-in-own-process' })
  const targetForeignTask = await create('task', { ...dates, process_id: ownProcess, owner_id: all.id, title: prefix + '-foreign-target' })
  const targetOwnTaskInForeignProcess = await create('task', { ...dates, process_id: foreignProcess, owner_id: own.id, title: prefix + '-foreign-resource-target' })
  const ownResource = await create('resources', { code: prefix + '-own', title: prefix + '-own', owner_id: own.id })
  const foreignResource = await create('resources', { code: prefix + '-foreign', title: prefix + '-foreign', owner_id: all.id })
  const ownMilestone = await create('milestone', { process_id: ownProcess, title: prefix + '-own', content: 'Mutation fixture', date: '2026-11-10' })
  const foreignMilestone = await create('milestone', { process_id: foreignProcess, title: prefix + '-foreign', content: 'Mutation fixture', date: '2026-11-10' })
  const ownAssignment = await create('assignment', { task_id: ownTask, resource_id: ownResource, quantity: 1 })
  const foreignTaskAssignment = await create('assignment', { task_id: foreignTaskInOwnProcess, resource_id: ownResource, quantity: 1 })
  const foreignResourceAssignment = await create('assignment', { task_id: ownTaskInForeignProcess, resource_id: foreignResource, quantity: 1 })
  const checkTarget = async (path, id, body) => {
    const before = await call(admin, 'GET', path + '/' + id)
    const result = await call(own.token, 'PUT', path + '/' + id, body)
    if (result.status !== 403) {
      failures.push(path + ' own-scope target change ' + JSON.stringify(body) + ': ' + result.status + ', expected 403')
      const restore = Object.fromEntries(Object.keys(body).map((key) => [key, before.data[key]]))
      expect((await call(admin, 'PUT', path + '/' + id, restore)).status).toBe(200)
    } else {
      expect((await call(admin, 'GET', path + '/' + id)).data).toEqual(before.data)
    }
    expect((await call(admin, 'GET', path + '/' + id)).data).toMatchObject(Object.fromEntries(Object.keys(body).map((key) => [key, before.data[key]])))
    expect((await call(all.token, 'PUT', path + '/' + id, body)).status, path + ' all-scope target change').toBe(200)
    expect((await call(admin, 'GET', path + '/' + id)).data).toMatchObject(body)
    expect((await call(admin, 'PUT', path + '/' + id, Object.fromEntries(Object.keys(body).map((key) => [key, before.data[key]])))).status).toBe(200)
  }
  const cases = [
    { path: 'assignment', own: ownAssignment, foreign: [foreignTaskAssignment, foreignResourceAssignment], patch: { quantity: 2 }, takeover: { task_id: ownTask, resource_id: ownResource }, targets: [{ task_id: targetForeignTask }, { task_id: targetOwnTaskInForeignProcess, resource_id: foreignResource }] },
    { path: 'milestone', own: ownMilestone, foreign: [foreignMilestone], patch: { title: prefix + '-edited' }, takeover: { process_id: ownProcess }, targets: [{ process_id: foreignProcess }] },
    { path: 'task', own: ownTask, foreign: [foreignTask], patch: { title: prefix + '-edited' }, takeover: { owner_id: own.id }, targets: [], allowed: [{ owner_id: all.id }] },
    { path: 'process', own: ownProcess, foreign: [foreignProcess], patch: { title: prefix + '-edited' }, takeover: { owner_id: own.id }, targets: [{ project_id: foreignProject }], allowed: [{ owner_id: all.id }] },
    { path: 'project', own: ownProject, foreign: [foreignProject], patch: { code: prefix + '-edited' }, takeover: { owner_id: own.id }, targets: [{ owner_id: all.id }] },
  ]
  for (const item of cases) {
    for (const id of item.foreign) {
      const path = item.path + '/' + id
      const before = await call(admin, 'GET', path)
      expect(before.status).toBe(200)
      expect((await call(own.token, 'GET', path)).status, path + ' visible foreign object').toBe(200)
      for (const body of [item.patch, item.takeover]) {
        expect((await call(own.token, 'PUT', path, body)).status, path + ' forbidden PUT').toBe(403)
        expect((await call(admin, 'GET', path)).data).toEqual(before.data)
      }
      expect((await call(own.token, 'DELETE', path)).status, path + ' forbidden DELETE').toBe(403)
      expect((await call(admin, 'GET', path)).data).toEqual(before.data)
    }
    const ownPath = item.path + '/' + item.own
    expect((await call(own.token, 'PUT', ownPath, item.patch)).status, ownPath + ' own PUT').toBe(200)
    expect((await call(admin, 'GET', ownPath)).data).toMatchObject(item.patch)
    for (const body of item.targets) await checkTarget(item.path, item.own, body)
    for (const body of item.allowed ?? []) {
      const before = await call(admin, 'GET', ownPath)
      expect((await call(own.token, 'PUT', ownPath, body)).status).toBe(200)
      expect((await call(admin, 'GET', ownPath)).data).toMatchObject(body)
      expect((await call(own.token, 'PUT', ownPath, Object.fromEntries(Object.keys(body).map((key) => [key, before.data[key]])))).status).toBe(200)
    }
    expect((await call(own.token, 'DELETE', ownPath)).status, ownPath + ' own DELETE').toBe(204)
    expect((await call(admin, 'GET', ownPath)).status).toBe(404)
    for (const id of item.foreign) {
      const path = item.path + '/' + id
      expect((await call(all.token, 'PUT', path, item.patch)).status, path + ' all PUT').toBe(200)
      expect((await call(admin, 'GET', path)).data).toMatchObject(item.patch)
      expect((await call(all.token, 'DELETE', path)).status, path + ' all DELETE').toBe(204)
      expect((await call(admin, 'GET', path)).status).toBe(404)
    }
    console.log('PASS ' + item.path + ': own PUT/DELETE allowed; foreign PUT/takeover/DELETE forbidden without changes; all PUT/DELETE allowed')
  }
  expect(failures, failures.join('\n')).toEqual([])
  console.log('PASS own-scope updates cannot transfer ownership or retarget milestones/assignments to foreign objects')
} finally {
  for (const id of projects) await call(admin, 'DELETE', 'project/' + id)
  for (const id of resources) await call(admin, 'DELETE', 'resources/' + id)
  for (const id of users) await call(admin, 'DELETE', 'user/' + id)
  await http.dispose()
}
