import { expect } from 'playwright/test'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { launchElectronFixture } from './helpers/electron.mjs'

const target = process.env.ERP_TEST_API, web = process.env.ERP_TEST_URL, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !target || !web || !['127.0.0.1', 'localhost'].includes(new URL(target).hostname)) throw new Error('An isolated local API, web URL and password are required')
const prefix = 'queue-' + randomUUID().slice(0, 8), report = [], business = [], errors = []
let fault = null, native, seedProject, seedResource, seedEmployee, seedState, access, releaseHold = () => {}
report.push = function (...cases) { for (const entry of cases) console.log('PASS', entry); return Array.prototype.push.apply(this, cases) }
const extraProjects = []
const direct = async (method, path, body) => {
  const response = await fetch(target + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: 'Bearer ' + access } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text(), result = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error('Fixture API ' + method + ' ' + path + ' returned ' + response.status)
  return result?.data
}
const proxy = createServer(async (request, response) => {
  try {
    const mutating = kinds(request), current = fault
    if (current?.type === 'offline') return response.destroy()
    if (mutating && current?.type === 'interrupt' && ++current.sends > (current.after || 1)) return response.destroy()
    const chunks = []; for await (const part of request) chunks.push(part)
    const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
    const bytes = Buffer.concat(chunks)
    if (mutating) business.push({ method: request.method, path: request.url, operation: request.headers['operation-id'], key: request.headers['idempotency-key'], body: bytes.length ? JSON.parse(bytes.toString()) : null })
    const result = await fetch(target + request.url, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : bytes, redirect: 'manual' })
    const content = Buffer.from(await result.arrayBuffer())
    if (mutating && current?.type === 'lose') { current.hit = true; expect(result.status).toBeGreaterThanOrEqual(200); expect(result.status).toBeLessThan(300); return response.destroy() }
    if (mutating && current?.type === 'hold' && !current.hit) { current.hit = true; await new Promise(resolve => { releaseHold = resolve }); return response.destroy() }
    const out = { 'Content-Type': 'application/json' }
    for (const name of ['Operation-Status', 'Retry-After', 'Revision-Status']) if (result.headers.get(name)) out[name] = result.headers.get(name)
    response.writeHead(result.status, out); response.end(content)
  } catch (error) { errors.push(error.message); response.destroy() }
})
function kinds(request) { return ['POST','PUT','DELETE'].includes(request.method) && !request.url.includes('/auth/') }
async function warm(page) {
  await page.evaluate(async () => {
    if (window.erpDesktop.queue.mainSync) await window.erpDesktop.queue.request({ action: 'sync', force: true, pullOnly: true, contextId: (await window.erpDesktop.session.status()).contextId })
    const store = await import('/src/store/index.ts')
    await store.usePlanningStore().refreshTaskPlanning(true)
    await store.usePlanningStore().refreshProcessPlanning(true)
    await store.usePlanningStore().refreshProjectPlanning(true)
    await store.useAppStore().refreshResources()
    window.queueStore = store
  })
}
async function rows(page) { return page.evaluate(async () => window.erpDesktop.queue.request({ action: 'list', contextId: (await window.erpDesktop.session.status()).contextId })) }
async function control(page, action, extra = {}) { return page.evaluate(async ({ action, extra }) => window.erpDesktop.queue.request({ action, ...extra, contextId: (await window.erpDesktop.session.status()).contextId }), { action, extra }) }
try {
  const login = await direct('POST', '/auth/login', { username: 'admin', password }); access = login.access_token
  const project = await direct('POST', '/project', { code: prefix, start_date: '2026-11-01', end_date: '2027-01-31', owner_id: login.user.id }); seedProject = project.id
  const fixtureProcess = await direct('POST', '/process', { title: prefix, project_id: seedProject, owner_id: login.user.id, start_date: '2026-11-01', end_date: '2027-01-31' })
  const task = await direct('POST', '/task', { title: prefix + '-baseline', process_id: fixtureProcess.id, start_date: '2026-11-09', end_date: '2026-11-22' })
  const secondTask = await direct('POST', '/task', { title: prefix + '-second', process_id: fixtureProcess.id, start_date: '2026-11-09', end_date: '2026-11-22' })
  const resource = await direct('POST', '/resources', { code: prefix, title: prefix, owner_id: login.user.id }); seedResource = resource.id
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  process.env.ERP_TEST_API = 'http://127.0.0.1:' + proxy.address().port
  native = await launchElectronFixture(); const context = native.app.context()
  await context.addInitScript(() => { localStorage.setItem('mvs_erp_auto_sync', '0'); Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Renderer must not use IndexedDB') } }) })
  let page = await native.app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message))
  await page.goto(web + '/login'); await page.locator('input[autocomplete=username]').fill('admin'); await page.locator('input[autocomplete=current-password]').fill(password); await page.locator('button[type=submit]').click()
  await expect(page.locator('.ah-burger')).toBeVisible(); await warm(page)
  await page.evaluate(async () => { window.queueContext = (await window.erpDesktop.session.status()).contextId })
  report.push('Native login and all planning reads work with IndexedDB denied')
  fault = { type: 'offline' }
  const saved = await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-offline' }), { task: task.id, prefix })
  expect(saved).toBe(true); expect((await rows(page)).length).toBe(1)
  await page.reload(); await expect(page.locator('.ah-burger')).toBeVisible(); await warm(page); await page.evaluate(async () => { window.queueContext = (await window.erpDesktop.session.status()).contextId })
  expect((await rows(page)).length).toBe(1)
  const cached = await page.evaluate(async () => (await (await import('/src/offline/cache.ts')).cacheGetByPath('/api/v1/planning/tasks'))?.data)
  expect(cached.processes.flatMap(row => row.tasks || []).find(row => row.id === task.id).title).toBe(prefix + '-offline')
  report.push('Offline edit survives window reload in SQLite without renderer IndexedDB')
  fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-offline')
  report.push('Reconnect confirms the same queued operation and updates server once')
  await warm(page)
  fault = { type: 'lose' }
  expect(await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-lost' }), { task: task.id, prefix })).toBe(true)
  await expect.poll(() => fault.hit).toBe(true)
  await expect.poll(async () => (await rows(page)).some(row => row.status === 'unknown')).toBe(true)
  const lost = (await rows(page))[0], before = business.filter(row => row.operation === lost.operationId).length
  fault = null; await control(page, 'retry', { operationId: lost.operationId }); await control(page, 'push')
  await expect.poll(async () => (await rows(page)).length).toBe(0)
  expect(business.filter(row => row.operation === lost.operationId).length).toBe(before)
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-lost')
  report.push('Response lost after actual database commit resolves by receipt without a second mutation')
  await warm(page)
  fault = { type: 'offline' }
  expect(await page.evaluate(({ process, prefix }) => window.queueStore.usePlanningStore().createTask({ title: prefix + '-new', process_id: process, start_date: '2026-11-10', end_date: '2026-11-20' }), { process: fixtureProcess.id, prefix })).toBe(true)
  const create = (await rows(page)).find(row => row.input.route === 'POST /task'); expect(create.http.tempId).toBeLessThan(0)
  expect(await page.evaluate(({ id, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(id, { title: prefix + '-edited' }), { id: create.http.tempId, prefix })).toBe(true)
  expect(await page.evaluate(id => window.queueStore.usePlanningStore().deleteTask(id), create.http.tempId)).toBe(true)
  expect((await rows(page)).length).toBe(3)
  fault = { type: 'lose' }
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(() => fault.hit).toBe(true)
  expect((await rows(page)).find(row => row.operationId === create.operationId)?.status).toBe('unknown')
  const createAttempts = business.filter(row => row.operation === create.operationId).length
  fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  expect(business.filter(row => row.operation === create.operationId)).toHaveLength(createAttempts)
  const delivered = business.filter(row => [create.operationId, ...(business.filter(row => row.path.includes('/task/') && row.body?.title === prefix + '-edited').map(row => row.operation))].includes(row.operation))
  expect(delivered.some(row => row.path.includes('-'))).toBe(false)
  const server = await direct('GET', '/planning/tasks'); expect(server.processes.flatMap(row => row.tasks || []).filter(row => row.title === prefix + '-new' || row.title === prefix + '-edited')).toHaveLength(0)
  report.push('Offline create edit delete recovers a lost creation response, resolves temporary IDs and leaves no duplicate task')
  await warm(page)
  fault = { type: 'offline' }
  expect((await page.evaluate(prefix => window.queueStore.usePlanningStore().createProject({ code: prefix + '-tree', start_date: '2026-11-01', end_date: '2027-01-31' }), prefix)).ok).toBe(true)
  const root = (await rows(page)).find(row => row.input.route === 'POST /project')
  expect(await page.evaluate(({ id, prefix }) => window.queueStore.usePlanningStore().createProcess({ project_id: id, title: prefix + '-tree-process', start_date: '2026-11-01', end_date: '2027-01-31' }), { id: root.http.tempId, prefix })).toBe(true)
  const branch = (await rows(page)).find(row => row.input.route === 'POST /process')
  expect(await page.evaluate(({ id, prefix }) => window.queueStore.usePlanningStore().createTask({ process_id: id, title: prefix + '-tree-task', start_date: '2026-11-09', end_date: '2026-11-22' }), { id: branch.http.tempId, prefix })).toBe(true)
  fault = { type: 'interrupt', sends: 0, after: 2 }
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); expect((await rows(page)).length).toBe(1)
  const pendingTreeTask = (await rows(page))[0]
  expect(pendingTreeTask.input.route).toBe('POST /task')
  await warm(page)
  const treeEdited = await page.evaluate(({ id, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(id, { title: prefix + '-tree-task-edited' }), { id: pendingTreeTask.http.tempId, prefix })
  if (!treeEdited) console.log('TREE_DIAGNOSTIC', await page.evaluate(async ({ id, prefix }) => {
    const planning = window.queueStore.usePlanningStore(); let source
    try { source = (await import('/src/store/data/nativeBaselines.ts')).capture({ route: 'PUT /task/{id}', path: { id: String(id) }, body: { title: prefix + '-tree-task-edited' } }) } catch (error) { source = String(error) }
    return { error: planning.error, processes: planning.taskPlanning?.processes.filter(row => row.title.includes(prefix)), source, queue: await window.erpDesktop.queue.request({ action: 'list', contextId: (await window.erpDesktop.session.status()).contextId }) }
  }, { id: pendingTreeTask.http.tempId, prefix }))
  expect(treeEdited).toBe(true)
  fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  const projectRows = await direct('GET', '/planning/projects'), treeProject = projectRows.projects.find(row => row.project_code === prefix + '-tree' || row.code === prefix + '-tree')
  expect(treeProject?.id).toBeGreaterThan(0); extraProjects.push(treeProject.id)
  expect((await direct('GET', '/planning/tasks')).processes.some(row => row.title === prefix + '-tree-process' && row.tasks.some(task => task.title === prefix + '-tree-task-edited'))).toBe(true)
  report.push('A whole offline tree resumes after partial parent confirmation and accepts an edit of its still-pending task')
  await warm(page)
  fault = { type: 'offline' }
  expect(await page.evaluate(({ process, prefix }) => window.queueStore.usePlanningStore().createTask({ title: prefix + '-assigned-new', process_id: process, start_date: '2026-11-09', end_date: '2026-11-22' }), { process: fixtureProcess.id, prefix })).toBe(true)
  const assigned = (await rows(page)).find(row => row.input.route === 'POST /task')
  expect(await page.evaluate(({ id, resource }) => window.queueStore.usePlanningStore().assignResource(id, resource, 2), { id: assigned.http.tempId, resource: seedResource })).toBe(true)
  fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  const assignedTask = (await direct('GET', '/planning/tasks')).processes.flatMap(row => row.tasks || []).find(row => row.title === prefix + '-assigned-new')
  expect(assignedTask.resources.find(row => row.id === seedResource)?.quantity).toBe(2)
  report.push('An offline resource assignment waits for its task creator and preserves quantity and both revision guards')
  const employee = await direct('POST', '/user', { username: prefix.replace(/-/g, '_') + 'e', first_name: 'Queue', last_name: 'Fixture', preset: 'worker', hire_date: '2026-01-01' }); seedEmployee = employee.user.id
  const absent = await direct('POST', '/timesheet/states', { code: prefix, name: prefix + '-absent', is_available: false }); seedState = absent.id
  await direct('POST', '/resources/' + seedResource + '/members', { user_id: seedEmployee })
  await warm(page)
  const periodBaseline = await page.evaluate(async id => {
    const timesheet = window.queueStore.useTimesheetStore(), app = window.queueStore.useAppStore()
    await timesheet.refreshStates(); await timesheet.refreshEmployees(); await timesheet.refreshPeriods('2026-11-09', '2026-11-15')
    await app.refreshResources(); await app.ensureResourceMembers(true); await app.refreshCalendar()
    return timesheet.periodBaseline(id, '2026-11-10', '2026-11-11')
  }, seedEmployee)
  expect(periodBaseline['user_days:' + seedEmployee]).toBeTruthy()
  fault = { type: 'offline' }
  expect(await page.evaluate(({ user, state }) => window.queueStore.useTimesheetStore().assignRange(user, state, '2026-11-10', '2026-11-11'), { user: seedEmployee, state: seedState })).toBe(true)
  expect(await page.evaluate(user => window.queueStore.useTimesheetStore().clearRange(user, '2026-11-11', '2026-11-11'), seedEmployee)).toBe(true)
  expect((await rows(page)).length).toBe(2)
  fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  const deliveredDays = await direct('GET', '/user/' + seedEmployee + '/days?start_date=2026-11-09&end_date=2026-11-15')
  expect(deliveredDays).toHaveLength(1); expect(deliveredDays[0].start_date).toBe('2026-11-10'); expect(deliveredDays[0].end_date).toBe('2026-11-10')
  report.push('An initially empty timesheet window supports offline absence add and partial delete through causal revision guards')
  await warm(page)
  fault = { type: 'offline' }
  for (const [id, title] of [[task.id, prefix + '-prefix'], [secondTask.id, prefix + '-suffix']]) expect(await page.evaluate(({ id, title }) => window.queueStore.usePlanningStore().updateTaskMeta(id, { title }), { id, title })).toBe(true)
  fault = { type: 'interrupt', sends: 0 }
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); expect((await rows(page)).length).toBe(1)
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-prefix')
  await page.reload(); await expect(page.locator('.ah-burger')).toBeVisible(); await warm(page); await page.evaluate(async () => { window.queueContext = (await window.erpDesktop.session.status()).contextId })
  expect((await rows(page)).length).toBe(1); fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  expect((await direct('GET', '/task/' + secondTask.id)).title).toBe(prefix + '-suffix')
  report.push('A second connection failure preserves only the unacknowledged suffix through a document reload')
  await warm(page)
  await native.app.evaluate(({ BrowserWindow }, { web, preload }) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } })
    globalThis.attachSessionFixture(window.webContents); void window.loadURL(web + '/projects')
  }, { web, preload: fileURLToPath(new URL('../desktop/preload.js', import.meta.url)) })
  await expect.poll(() => native.app.windows().length).toBe(2)
  const sibling = native.app.windows().find(tab => tab !== page); await expect(sibling.locator('.ah-burger')).toBeVisible()
  await sibling.evaluate(() => { window.observedQueueEvents = []; window.queueObserver = window.erpDesktop.service.subscribe(state => window.observedQueueEvents.push(state.queue)) })
  await warm(sibling)
  await sibling.evaluate(async () => { window.releaseSourceGuard = (await import('/src/offline/mutationGuard.ts')).beginMutation() })
  fault = { type: 'hold' }
  expect(await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-observed-origin' }), { task: task.id, prefix })).toBe(true)
  await expect.poll(() => fault.hit).toBe(true)
  expect(await sibling.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-stale-second-window' }), { task: task.id, prefix })).toBe(true)
  const staleOperation = (await rows(sibling)).find(row => row.input.body.title === prefix + '-stale-second-window').operationId
  fault = null; releaseHold()
  await expect.poll(() => native.app.evaluate(() => globalThis.commandQueueFixture.status().running)).toBe(false)
  for (const row of await rows(sibling)) if (row.status === 'unknown') await control(sibling, 'retry', { operationId: row.operationId })
  await control(sibling, 'push')
  await expect.poll(async () => (await rows(sibling)).find(row => row.operationId === staleOperation)?.status).toBe('conflict')
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-observed-origin')
  await control(sibling, 'discard', { operationIds: [staleOperation] })
  await sibling.evaluate(() => { window.releaseSourceGuard(); delete window.releaseSourceGuard })
  await warm(page); await warm(sibling)
  report.push('A second window that did not observe the pending first edit receives a conflict instead of borrowing its version')
  fault = { type: 'hold' }
  expect(await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-owner-closed' }), { task: task.id, prefix })).toBe(true)
  await expect.poll(() => fault.hit).toBe(true)
  try { await expect.poll(() => sibling.evaluate(async () => (await import('/src/offline/outbox.ts')).pendingCount.value)).toBe(1) }
  catch (error) {
    console.log('PENDING_DIAGNOSTIC', await sibling.evaluate(async () => {
      const data = await import('/src/offline/outbox.ts'), queue = await import('/src/offline/desktopQueue.ts'), auth = (await import('/src/store/index.ts')).useAuthStore()
      let commands; try { commands = (await queue.nativeCommands()).map(row => ({ id: row.operationId, status: row.status })) } catch (e) { commands = String(e) }
      return { commands, count: data.pendingCount.value, active: (await import('/src/offline/mutationGuard.ts')).hasActiveMutations(), authenticated: auth.isAuthenticated, service: await window.erpDesktop.service.status(), runtime: (await import('/src/platform/current.ts')).currentRuntime.value?.kind, phase: (await import('/src/platform/current.ts')).currentRuntime.value?.phase.value, events: window.observedQueueEvents }
    }))
    throw error
  }
  await page.close(); page = sibling; await warm(page); await page.evaluate(async () => { window.queueContext = (await window.erpDesktop.session.status()).contextId })
  expect((await rows(page)).length).toBe(1)
  fault = null; releaseHold()
  await expect.poll(() => native.app.evaluate(() => globalThis.commandQueueFixture.status().running)).toBe(false)
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-owner-closed')
  report.push('Two windows share pending state; closing the originating window does not cancel a committed in-flight command')
  await warm(page)
  fault = { type: 'hold' }
  expect(await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-late-own-ack' }), { task: task.id, prefix })).toBe(true)
  await expect.poll(() => fault.hit).toBe(true)
  await direct('PUT', '/task/' + task.id, { title: prefix + '-newer-than-ack' })
  await page.evaluate(() => window.queueStore.usePlanningStore().refreshTaskPlanning(true))
  fault = null; releaseHold()
  await expect.poll(() => native.app.evaluate(() => globalThis.commandQueueFixture.status().running)).toBe(false)
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page)).length).toBe(0)
  const latestCache = await page.evaluate(async () => (await (await import('/src/offline/cache.ts')).cacheGetByPath('/api/v1/planning/tasks'))?.data)
  expect(latestCache.processes.flatMap(row => row.tasks || []).find(row => row.id === task.id).title).toBe(prefix + '-newer-than-ack')
  report.push('Receipt recovery for an older own commit preserves a newer external GET already committed to SQLite')
  await warm(page)
  fault = { type: 'offline' }
  expect(await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-conflicting-offline' }), { task: task.id, prefix })).toBe(true)
  expect(await page.evaluate(({ task, prefix }) => window.queueStore.usePlanningStore().updateTaskMeta(task, { title: prefix + '-dependent-offline' }), { task: task.id, prefix })).toBe(true)
  await direct('PUT', '/task/' + task.id, { title: prefix + '-external' })
  fault = null
  for (const row of await rows(page)) await control(page, 'retry', { operationId: row.operationId })
  await control(page, 'push'); await expect.poll(async () => (await rows(page))[0]?.status).toBe('conflict')
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-external')
  report.push('An external edit wins over stale offline data through an explicit conflict, without losing the queued intent')
  const conflictRows = await rows(page)
  expect(conflictRows).toHaveLength(2); expect(conflictRows[1].ready).toBe(false)
  await page.goto(web + '/system/queue')
  const labels = await page.evaluate(async () => { const { t } = await import('/src/i18n'); return { discard: t('adminSystem.queue.errors.discard'), confirm: t('adminSystem.queue.messages.discardConfirmLabel'), message: t('adminSystem.queue.messages.discardConfirm', { count: 2 }) } })
  await page.getByRole('button', { name: labels.discard, exact: true }).click()
  await expect(page.getByText(labels.message, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: labels.confirm, exact: true }).click()
  await expect.poll(async () => (await rows(page)).length).toBe(0)
  expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + '-external')
  report.push('Queue UI explicitly confirms cancelling a conflict and its unsent dependent without changing the server')
  expect(errors).toEqual([])
  console.log(JSON.stringify({ cases: report.length, report }, null, 2))
} finally {
  fault = null; releaseHold(); await native?.close(); await new Promise(resolve => proxy.close(resolve))
  for (const id of extraProjects) await direct('DELETE', '/project/' + id).catch(() => {})
  if (seedProject) await direct('DELETE', '/project/' + seedProject).catch(() => {})
  if (seedResource) await direct('DELETE', '/resources/' + seedResource).catch(() => {})
  if (seedEmployee) await direct('DELETE', '/user/' + seedEmployee).catch(() => {})
  if (seedState) await direct('DELETE', '/timesheet/states/' + seedState).catch(() => {})
}
