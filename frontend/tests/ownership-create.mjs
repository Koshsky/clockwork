import { request, expect } from 'playwright/test'
import fs from 'node:fs'

const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]
}))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'ownership-create-' + Date.now()
const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const users = [], projects = [], resources = [], failures = []
let sequence = 0
const label = () => prefix + '-' + ++sequence
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
async function create(token, path, body, expected = {}) {
  const response = await call(token, 'POST', path, body)
  expect(response.status, path + ' create: ' + JSON.stringify(response.error)).toBe(201)
  if (path === 'project') projects.push(response.data.id)
  if (path === 'resources') resources.push(response.data.id)
  expect(response.data).toMatchObject(expected)
  const saved = await call(admin, 'GET', path + '/' + response.data.id)
  expect(saved.status).toBe(200)
  expect(saved.data).toMatchObject(expected)
  return response.data.id
}
async function user(scope, view = 'all') {
  const permissions = ['project', 'process', 'task', 'milestone', 'assignment'].flatMap((resource) => ['view', 'create'].map((action) => ({ resource, action, scope: action === 'view' ? (view === 'all' ? 'all' : resource === 'project' ? 'self' : 'up1') : scope === 'all' ? 'all' : resource === 'project' ? 'self' : 'up1', granted: true })))
  const username = 'cre' + Date.now().toString().slice(-9) + scope + view
  const response = await call(admin, 'POST', 'user', { username, first_name: 'Create', last_name: 'Test', preset: 'worker', permissions })
  expect(response.status).toBe(201)
  users.push(response.data.user.id)
  const auth = await call(null, 'POST', 'auth/login', { username, password: response.data.password })
  expect(auth.status).toBe(200)
  return { id: response.data.user.id, token: auth.data.access_token }
}
async function deny(actor, path, body, name, statuses = [403]) {
  const before = await call(admin, 'GET', path + '?limit=1')
  expect(before.status).toBe(200)
  const result = await call(actor.token, 'POST', path, body)
  const after = await call(admin, 'GET', path + '?limit=1')
  expect(after.status).toBe(200)
  if (!statuses.includes(result.status) || after.data.total !== before.data.total) {
    failures.push(name + ': HTTP ' + result.status + ', expected ' + statuses.join('/') + '; total ' + before.data.total + ' -> ' + after.data.total)
    if (result.status === 201) await call(admin, 'DELETE', path + '/' + result.data.id)
  } else {
    expect(result.data ?? {}).toEqual({})
    console.log('PASS rejected without creating a row: ' + name)
  }
}
try {
  const own = await user('self'), all = await user('all'), limited = await user('self', 'self')
  const project = (owner) => ({ ...dates, code: label(), owner_id: owner })
  const process = (project_id, owner_id) => ({ ...dates, project_id, owner_id, title: label() })
  const task = (process_id, owner_id) => ({ ...dates, process_id, owner_id, title: label() })
  const milestone = (process_id) => ({ process_id, title: label(), content: 'Ownership create fixture', date: '2026-11-10' })
  const ownProject = await create(admin, 'project', project(own.id))
  const foreignProject = await create(admin, 'project', project(all.id))
  const limitedProject = await create(admin, 'project', project(limited.id))
  const ownProcess = await create(admin, 'process', process(ownProject, own.id))
  const foreignProcess = await create(admin, 'process', process(ownProject, all.id))
  const hiddenProcess = await create(admin, 'process', process(foreignProject, all.id))
  const limitedProcess = await create(admin, 'process', process(limitedProject, limited.id))
  const ownTask = await create(admin, 'task', task(ownProcess, own.id))
  const foreignTask = await create(admin, 'task', task(ownProcess, all.id))
  const ownTaskInForeignProcess = await create(admin, 'task', task(foreignProcess, own.id))
  const hiddenParent = await create(admin, 'task', task(limitedProcess, all.id))
  const misleadingParent = await create(admin, 'task', task(hiddenProcess, limited.id))
  const limitedTask = await create(admin, 'task', task(limitedProcess, limited.id))
  const ownResource = await create(admin, 'resources', { code: label(), title: label(), owner_id: own.id })
  const foreignResource = await create(admin, 'resources', { code: label(), title: label(), owner_id: all.id })
  const limitedResource = await create(admin, 'resources', { code: label(), title: label(), owner_id: limited.id })

  for (const [path, make] of [
    ['project', () => ({ ...dates, code: label() })],
    ['process', () => ({ ...dates, project_id: ownProject, title: label() })],
    ['task', () => ({ ...dates, process_id: ownProcess, title: label() })],
  ]) {
    for (const owner of path === 'project' ? [undefined, null, own.id, 0] : [undefined, null, own.id, all.id]) {
      const body = make()
      if (owner !== undefined) body.owner_id = owner
      await create(own.token, path, body, { owner_id: path !== 'project' && owner === all.id ? all.id : own.id })
    }
    if (path === 'project') await deny(own, path, { ...make(), owner_id: all.id }, path + ' forged foreign owner')
    await deny(own, path, { ...make(), owner_id: -1 }, path + ' negative owner', [400, 403])
    if (path !== 'project') await deny(own, path, { ...make(), owner_id: 0 }, path + ' zero owner', [400, 403])
    for (const owner of [String(all.id), true, 1.5]) await deny(own, path, { ...make(), owner_id: owner }, path + ' malformed owner ' + JSON.stringify(owner), [400])
    console.log('PASS ' + path + ': omitted/null/explicit own owner and foreign/malformed owner checks')
  }
  await deny(limited, 'process', process(foreignProject, limited.id), 'process in inaccessible foreign project')
  await deny(limited, 'task', task(hiddenProcess, limited.id), 'task in inaccessible foreign process')
  await deny(own, 'process', process(foreignProject, own.id), 'visible foreign project cannot be bypassed with own owner_id')
  await deny(own, 'task', task(foreignProcess, own.id), 'visible foreign process cannot be bypassed with own owner_id')
  await create(limited.token, 'process', process(limitedProject, undefined), { owner_id: limited.id })
  await create(limited.token, 'task', task(limitedProcess, undefined), { owner_id: limited.id })
  await create(limited.token, 'task', { ...task(limitedProcess, limited.id), parent_id: limitedTask }, { owner_id: limited.id, parent_id: limitedTask, process_id: limitedProcess })
  await create(limited.token, 'task', { ...task(limitedProcess, limited.id), parent_id: hiddenParent }, { parent_id: hiddenParent, process_id: limitedProcess, owner_id: limited.id })
  await deny(limited, 'task', { ...task(hiddenProcess, limited.id), parent_id: misleadingParent }, 'subtask under parent in foreign process')
  await deny(limited, 'task', { ...task(limitedProcess, limited.id), parent_id: misleadingParent }, 'subtask process_id smuggling into inaccessible process', [400, 403])
  await deny(all, 'task', { ...task(limitedProcess, all.id), parent_id: misleadingParent }, 'all subtask process_id mismatch', [400])
  await deny({ token: admin }, 'task', { ...task(limitedProcess, all.id), parent_id: misleadingParent }, 'admin subtask process_id mismatch', [400])
  await create(own.token, 'task', { ...task(ownProcess, all.id), parent_id: ownTask }, { parent_id: ownTask, process_id: ownProcess, owner_id: all.id })
  await deny(own, 'task', { ...task(ownProcess, own.id), parent_id: ownTaskInForeignProcess }, 'visible parent cannot substitute process_id', [400])

  await create(own.token, 'milestone', { ...milestone(ownProcess), owner_id: all.id }, { process_id: ownProcess })
  await deny(own, 'milestone', { ...milestone(foreignProcess), owner_id: own.id }, 'milestone in foreign process inside own project')
  await deny(limited, 'milestone', milestone(hiddenProcess), 'milestone in inaccessible foreign process')
  await create(own.token, 'assignment', { task_id: ownTask, resource_id: ownResource, quantity: 1, owner_id: all.id }, { task_id: ownTask, resource_id: ownResource })
  await create(limited.token, 'assignment', { task_id: limitedTask, resource_id: limitedResource, quantity: 1 }, { task_id: limitedTask, resource_id: limitedResource })
  await deny(own, 'assignment', { task_id: foreignTask, resource_id: ownResource, quantity: 1, owner_id: own.id }, 'assignment to foreign task with own resource')
  await deny(own, 'assignment', { task_id: ownTask, resource_id: foreignResource, quantity: 1 }, 'assignment of foreign resource into own process')
  await deny(own, 'assignment', { task_id: ownTaskInForeignProcess, resource_id: foreignResource, quantity: 1, owner_id: own.id }, 'assignment of foreign resource to own task in foreign process')
  await deny(limited, 'assignment', { task_id: hiddenParent, resource_id: limitedResource, quantity: 1 }, 'assignment to inaccessible task')

  await create(all.token, 'project', project(own.id), { owner_id: own.id })
  await create(all.token, 'process', process(foreignProject, own.id), { project_id: foreignProject, owner_id: own.id })
  await create(all.token, 'task', task(foreignProcess, own.id), { process_id: foreignProcess, owner_id: own.id })
  await create(all.token, 'milestone', milestone(foreignProcess), { process_id: foreignProcess })
  await create(all.token, 'assignment', { task_id: foreignTask, resource_id: ownResource, quantity: 1 }, { task_id: foreignTask, resource_id: ownResource })
  await deny(all, 'assignment', { task_id: ownTask, resource_id: foreignResource, quantity: 1 }, 'all assignment cannot bypass process/resource owner invariant')
  await deny({ token: admin }, 'assignment', { task_id: ownTask, resource_id: foreignResource, quantity: 1 }, 'admin assignment cannot bypass process/resource owner invariant')
  expect(failures, failures.join('\n')).toEqual([])
  console.log('PASS own-scope creation: owner forgery, invisible parents, subtasks, milestones, resource ownership and all/admin controls')
} finally {
  for (const id of projects) await call(admin, 'DELETE', 'project/' + id)
  for (const id of resources) await call(admin, 'DELETE', 'resources/' + id)
  for (const id of users) await call(admin, 'DELETE', 'user/' + id)
  await http.dispose()
}
