import { expect } from 'playwright/test'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { launchElectronFixture } from './helpers/electron.mjs'

const target = process.env.ERP_TEST_API, web = process.env.ERP_TEST_URL, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !target || !web || !['127.0.0.1', 'localhost'].includes(new URL(target).hostname)) throw new Error('An isolated local API, web URL and password are required')
const prefix = 'sync-' + randomUUID().slice(0, 8), report = [], errors = [], requests = []
let access, native, account, project, resource, offline = false
const api = async (method, path, body) => {
  const response = await fetch(target + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: 'Bearer ' + access } : {}) }, body: body == null ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error('Fixture ' + method + ' ' + path + ': ' + response.status)
  return response.status === 204 ? null : (await response.json()).data
}
const proxy = createServer(async (request, response) => {
  try {
    if (offline) return response.destroy()
    const chunks = []; for await (const part of request) chunks.push(part)
    const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
    requests.push({ method: request.method, path: request.url })
    const result = await fetch(target + request.url, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks) })
    const bytes = Buffer.from(await result.arrayBuffer()), out = { 'Content-Type': 'application/json' }
    for (const name of ['Operation-Status', 'Revision-Status', 'Retry-After']) if (result.headers.get(name)) out[name] = result.headers.get(name)
    response.writeHead(result.status, out); response.end(bytes)
  } catch { response.destroy() }
})
const control = (page, action, extra = {}) => page.evaluate(async ({ action, extra }) => window.erpDesktop.queue.request({ action, ...extra, contextId: (await window.erpDesktop.session.status()).contextId }), { action, extra })
const titleIn = (page, id) => page.evaluate(async id => (await import('/src/store/index.ts')).usePlanningStore().taskPlanning?.processes?.flatMap(row => row.tasks || []).find(row => row.id === id)?.title ?? null, id)
const mark = text => { report.push(text); console.log('PASS', text) }
try {
  const login = await api('POST', '/auth/login', { username: 'admin', password }); access = login.access_token
  account = await api('POST', '/user', { username: prefix.replaceAll('-', ''), preset: 'worker', first_name: 'Sync', last_name: 'Fixture' })
  await api('PUT', '/rbac/users/' + account.user.id + '/permissions', { overrides: [
    { resource: 'project', action: 'view', scope: 'all', granted: true },
    { resource: 'task', action: 'update', scope: 'all', granted: true },
    { resource: 'resource', action: 'view', scope: 'all', granted: true },
  ] })
  project = await api('POST', '/project', { code: prefix, owner_id: login.user.id, start_date: '2026-11-01', end_date: '2026-12-31' })
  const fixtureProcess = await api('POST', '/process', { title: prefix, project_id: project.id, owner_id: login.user.id, start_date: '2026-11-01', end_date: '2026-12-31' })
  const task = await api('POST', '/task', { title: prefix + '-before', process_id: fixtureProcess.id, start_date: '2026-11-09', end_date: '2026-11-22' })
  const second = await api('POST', '/task', { title: prefix + '-second', process_id: fixtureProcess.id, start_date: '2026-11-09', end_date: '2026-11-22' })
  resource = await api('POST', '/resources', { code: prefix, title: prefix, owner_id: login.user.id })
  await api('POST', '/assignment', { task_id: task.id, resource_id: resource.id, quantity: 1 })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  process.env.ERP_TEST_API = 'http://127.0.0.1:' + proxy.address().port
  native = await launchElectronFixture(); const context = native.app.context()
  await context.addInitScript(() => { localStorage.setItem('mvs_erp_auto_sync', '0'); Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Renderer IndexedDB is forbidden') } }) })
  const first = await native.app.firstWindow(); first.on('pageerror', error => errors.push(error.message))
  await first.goto(web + '/login'); await first.locator('input[autocomplete=username]').fill(account.user.username); await first.locator('input[autocomplete=current-password]').fill(account.password); await first.locator('button[type=submit]').click()
  await expect(first.locator('.ah-burger')).toBeVisible(); await control(first, 'sync', { force: true })
  await expect.poll(() => titleIn(first, task.id)).toBe(prefix + '-before')
  await native.app.evaluate(({ BrowserWindow }, { web, preload }) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } })
    globalThis.attachSessionFixture(win.webContents); void win.loadURL(web + '/planner')
  }, { web, preload: fileURLToPath(new URL('../desktop/preload.js', import.meta.url)) })
  await expect.poll(() => native.app.windows().length).toBe(2)
  const secondWindow = native.app.windows().find(page => page !== first); secondWindow.on('pageerror', error => errors.push(error.message))
  await expect(secondWindow.locator('.ah-burger')).toBeVisible()
  await secondWindow.evaluate(async () => (await import('/src/store/index.ts')).usePlanningStore().refreshTaskPlanning(true, true))
  await expect.poll(() => titleIn(secondWindow, task.id)).toBe(prefix + '-before')
  const count = requests.filter(row => row.path === '/api/v1/planning/tasks').length
  await Promise.all([first, secondWindow].map(page => page.evaluate(async () => (await import('/src/store/index.ts')).usePlanningStore().refreshTaskPlanning(true, true))))
  expect(requests.filter(row => row.path === '/api/v1/planning/tasks').length).toBe(count)
  mark('Two actual Electron windows hydrate one main-owned snapshot without duplicate GETs')
  await api('PUT', '/task/' + task.id, { title: prefix + '-web' })
  await control(first, 'sync', { force: true })
  for (const page of [first, secondWindow]) await expect.poll(() => titleIn(page, task.id)).toBe(prefix + '-web')
  mark('An external web writer updates both windows after one pull')
  const assignmentsIn = page => page.evaluate(async id => (await import('/src/store/index.ts')).usePlanningStore().taskPlanning?.processes?.flatMap(row => row.tasks || []).find(row => row.id === id)?.resources?.length ?? 0, task.id)
  for (const page of [first, secondWindow]) expect(await assignmentsIn(page)).toBe(1)
  await api('PUT', '/resources/' + resource.id, { owner_id: account.user.id })
  await control(first, 'sync', { force: true })
  for (const page of [first, secondWindow]) await expect.poll(() => assignmentsIn(page)).toBe(0)
  const header = await control(first, 'cacheGet', { key: '/local/resource-header?owner_id=' + account.user.id })
  expect(header.data.some(row => row.id === resource.id)).toBe(true)
  mark('External resource ownership change removes assignments in both windows and updates the owned-resource header')
  await api('PUT', '/resources/' + resource.id, { owner_id: login.user.id })
  await api('POST', '/assignment', { task_id: task.id, resource_id: resource.id, quantity: 1 })
  await control(first, 'sync', { force: true })
  for (const page of [first, secondWindow]) await expect.poll(() => assignmentsIn(page)).toBe(1)
  await api('PUT', '/process/' + fixtureProcess.id, { owner_id: account.user.id })
  await control(first, 'sync', { force: true })
  for (const page of [first, secondWindow]) await expect.poll(() => assignmentsIn(page)).toBe(0)
  mark('External process ownership change removes resource badges without removing the process or its tasks')

  offline = true
  expect(await first.evaluate(async ({ id, title }) => (await import('/src/store/index.ts')).usePlanningStore().updateTaskMeta(id, { title }), { id: task.id, title: prefix + '-local' })).toBe(true)
  await expect.poll(async () => (await control(first, 'list')).length).toBe(1)
  await api('PUT', '/task/' + task.id, { title: prefix + '-external-conflict' })
  offline = false; const queued = await control(first, 'list')
  for (const row of queued) await control(first, 'retry', { operationId: row.operationId })
  await control(first, 'sync', { force: true })
  await expect.poll(async () => (await control(first, 'list'))[0]?.status).toBe('conflict')
  const conflict = (await control(first, 'list'))[0]
  const review = await control(first, 'reviewConflict', { operationId: conflict.operationId })
  expect(review.local.title).toBe(prefix + '-local'); expect(review.server.title).toBe(prefix + '-external-conflict')
  expect((await api('GET', '/task/' + task.id)).title).toBe(prefix + '-external-conflict')
  await first.goto(web + '/system/queue')
  await first.getByRole('button', { name: 'Сравнить версии' }).click()
  await expect(first.locator('.queue-info-body').filter({ hasText: prefix + '-external-conflict' })).toBeVisible()
  await first.getByRole('button', { name: 'Решить позже' }).click()
  expect((await control(first, 'list')).length).toBe(1)
  await control(first, 'discard', { operationIds: review.operationIds })
  mark('A real revision conflict exposes both versions; deferring preserves the intent, explicit cancellation resolves it')
  await api('DELETE', '/task/' + task.id); await control(first, 'sync', { force: true })
  for (const page of [first, secondWindow]) await expect.poll(() => titleIn(page, task.id)).toBe(null)
  mark('External deletion removes the task from both windows')
  offline = true
  expect(await secondWindow.evaluate(async ({ id, title }) => (await import('/src/store/index.ts')).usePlanningStore().updateTaskMeta(id, { title }), { id: second.id, title: prefix + '-retained' })).toBe(true)
  await api('PUT', '/rbac/users/' + account.user.id + '/permissions', { overrides: [] })
  offline = false
  for (const row of await control(first, 'list')) await control(first, 'retry', { operationId: row.operationId })
  await control(first, 'sync', { force: true })
  for (const page of [first, secondWindow]) {
    await expect.poll(() => titleIn(page, second.id)).toBe(null)
    expect(await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().can('project', 'view'))).toBe(false)
  }
  expect((await control(first, 'list')).some(row => row.input.body.title === prefix + '-retained')).toBe(true)
  mark('Revoked permissions remove cached content in both windows while retaining rejected intent for explicit review')
  expect(errors).toEqual([])
  console.log(JSON.stringify({ cases: report.length, report }, null, 2))
} finally {
  offline = false
  await native?.close()
  await new Promise(resolve => proxy.close(resolve))
  if (project) await api('DELETE', '/project/' + project.id)
  if (resource) await api('DELETE', '/resources/' + resource.id)
  if (account) await api('DELETE', '/user/' + account.user.id)
}
