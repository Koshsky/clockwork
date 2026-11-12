import { chromium, expect, request } from 'playwright/test'

const web = process.env.ERP_TEST_URL, api = process.env.RBAC_TEST_API_URL
if (process.env.ERP_TEST_ISOLATED !== '1' || !web || !api || !process.env.RBAC_TEST_ADMIN_PASSWORD) throw new Error('An explicit isolated local API, web URL and password are required')
for (const url of [web, api]) if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local fixtures only')
const http = await request.newContext({ baseURL: api + '/' })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const pages = [], errors = [], writes = [], report = [], projects = [], resources = [], users = [], states = []
const prefix = 'cmd' + Date.now().toString(36), dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
let token, fault, lost, release = () => {}
async function call(method, path, data) {
  const response = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
  if (!response.ok()) throw new Error(method + ' ' + path + ': ' + response.status() + ' ' + (await response.json())?.error?.message)
  return response.status() === 204 ? null : (await response.json()).data
}
await context.addInitScript(origin => {
  if (location.origin !== origin) return
  localStorage.setItem('mvs_erp_auto_sync', '0'); localStorage.setItem('mvs_erp_ui_lang', 'ru')
  window.outboxWrites = []
  for (const method of ['add', 'put']) {
    const original = IDBObjectStore.prototype[method]
    IDBObjectStore.prototype[method] = function (...args) {
      if (this.name === 'outbox') { window.outboxWrites.push(method); throw new Error('Web commands must not enqueue') }
      return original.apply(this, args)
    }
  }
}, new URL(web).origin)
context.on('page', page => { pages.push(page); page.on('pageerror', error => errors.push(error.message)) })
await context.route('**/api/v1/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) && !path.includes('/auth/')
  if (!mutation) return route.continue()
  writes.push({ path, method: req.method(), key: req.headers()['idempotency-key'], body: req.postDataJSON() })
  const own = fault
  if (own && (!own.path || own.path === path)) {
    if (own.kind === 'offline') return route.abort('failed')
    if (own.kind === 'reject') return route.fulfill({ status: own.status, json: { data: null, error: { code: own.status, message: 'Fixture refusal' } } })
    if (own.kind === 'timeout') {
      await new Promise(resolve => setTimeout(resolve, 80))
      return route.abort('timedout')
    }
    if (own.kind === 'hold' && !own.hit) {
      own.hit = true; await new Promise(resolve => { release = resolve })
    }
    if (own.kind === 'lost' && !own.hit) {
      own.hit = true
      const response = await route.fetch({ maxRetries: 0 })
      expect(response.ok()).toBe(true)
      lost = { key: req.headers()['idempotency-key'] }
      return route.abort('failed')
    }
  }
  const response = await route.fetch({ maxRetries: 0 })
  await route.fulfill({ response })
})
async function runtime(page) {
  await page.evaluate(async () => {
    const store = await import('/src/store/index.ts'), commands = await import('/src/store/data/webCommands.ts')
    const settings = await import('/src/settings.ts'); settings.autoSync.value = false
    window.fixture = { app: store.useAppStore(), planning: store.usePlanningStore(), timesheet: store.useTimesheetStore(), rbac: store.useRbacStore(), auth: store.useAuthStore(), commands }
  })
}
async function act(page, domain, action, args = []) {
  const result = await page.evaluate(({ domain, action, args }) => window.fixture[domain][action](...args), { domain, action, args })
  if (result === false) console.log('RESULT', domain, action, await page.evaluate(() => [window.fixture.planning.error, window.fixture.app.resourcesError, window.fixture.timesheet.error].filter(Boolean)))
  return result
}
async function refresh(page) {
  for (const action of ['refreshProjectPlanning', 'refreshProcessPlanning', 'refreshTaskPlanning']) await act(page, 'planning', action, [true])
}
async function rows(page) {
  return page.evaluate(() => window.fixture.planning.taskPlanning?.processes?.flatMap(p => p.tasks || []) || [])
}
async function clearUnknown(page) { await page.evaluate(() => window.fixture.commands.resetWebCommands()) }
async function noQueue(page) {
  expect(await page.evaluate(() => window.outboxWrites)).toEqual([])
  expect(await page.evaluate(async () => (await import('/src/offline/db.ts')).idbAll('outbox').then(rows => rows.length))).toBe(0)
}
const page = await context.newPage(); page.setDefaultTimeout(20000)
try {
  const login = await call('POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD }); token = login.access_token
  await page.goto(web + '/login'); await page.locator('input[autocomplete=username]').fill('admin'); await page.locator('input[autocomplete=current-password]').fill(process.env.RBAC_TEST_ADMIN_PASSWORD); await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/); await runtime(page); await refresh(page)
  expect((await act(page, 'planning', 'createProject', [{ ...dates, code: prefix }])).ok).toBe(true)
  const project = (await call('GET', 'project?limit=500')).items.find(row => row.code === prefix); projects.push(project.id)
  expect(await act(page, 'planning', 'createProcess', [{ ...dates, project_id: project.id, owner_id: login.user.id, title: prefix }])).toBe(true)
  await refresh(page)
  const processRow = (await call('GET', 'planning/tasks')).processes.find(row => row.title === prefix)
  expect(await act(page, 'planning', 'createTask', [{ process_id: processRow.id, title: prefix, start_date: '2026-11-09', end_date: '2026-11-15' }])).toBe(true)
  const task = (await rows(page)).find(row => row.title === prefix)
  expect(await act(page, 'planning', 'createSubtask', [task.id, { title: prefix + '-sub' }])).toBe(true)
  await refresh(page)
  const subtask = (await rows(page)).find(row => row.id === task.id).subtasks[0]
  expect(await act(page, 'planning', 'updateSubtask', [subtask.id, { title: prefix + '-sub-edited' }])).toBe(true)
  expect(await act(page, 'planning', 'createMilestone', [{ process_id: processRow.id, title: prefix, content: 'Acceptance fixture', date: '2026-11-13' }])).toBe(true)
  await refresh(page)
  const milestone = (await call('GET', 'planning/tasks')).processes.find(row => row.id === processRow.id).milestones[0]
  expect(await act(page, 'app', 'createResource', [{ code: prefix, title: prefix }])).toBe(true)
  const resource = (await call('GET', 'resources?limit=500')).items.find(row => row.code === prefix); resources.push(resource.id)
  expect(await act(page, 'app', 'updateResource', [resource.id, { title: prefix + '-edited' }])).toBe(true)
  const employee = await act(page, 'app', 'createUser', [{ username: prefix, first_name: 'Fixture', last_name: 'Commands', manager_id: login.user.id, preset: 'worker' }]); users.push(employee.user.id)
  expect(await act(page, 'app', 'updateUser', [employee.user.id, { position: 'Acceptance' }])).toBe(true)
  expect(await act(page, 'app', 'updateManager', [employee.user.id, login.user.id])).toBe(true)
  expect(await act(page, 'app', 'addResourceMember', [resource.id, employee.user.id])).toBe(true)
  expect(await act(page, 'timesheet', 'createState', [{ code: prefix, name: prefix, is_available: false }])).toBe(true)
  const state = (await call('GET', 'timesheet/states')).find(row => row.code === prefix); states.push(state.id)
  expect(await act(page, 'timesheet', 'updateState', [state.id, { name: prefix + '-edited' }])).toBe(true)
  await page.evaluate(({ employee, state }) => { const ts = window.fixture.timesheet; ts.employees = [employee]; ts.states = [state]; ts.windowStart = '2026-11-01'; ts.windowEnd = '2026-11-30' }, { employee: employee.user, state })
  expect(await act(page, 'timesheet', 'assignRange', [employee.user.id, state.id, '2026-11-10', '2026-11-12'])).toBe(true)
  expect(await act(page, 'timesheet', 'clearRange', [employee.user.id, '2026-11-10', '2026-11-12'])).toBe(true)
  expect(await act(page, 'planning', 'assignResource', [task.id, resource.id, 1])).toBe(true)
  expect(await act(page, 'planning', 'removeResource', [task.id, resource.id])).toBe(true)
  expect(await act(page, 'planning', 'updateProjectMeta', [project.id, { color: '#234567' }])).toBe(true)
  expect(await act(page, 'planning', 'updateProcessMeta', [processRow.id, { title: prefix + '-edited' }])).toBe(true)
  expect(await act(page, 'planning', 'updateTaskMeta', [task.id, { title: prefix + '-edited' }])).toBe(true)
  expect(await act(page, 'planning', 'updateMilestoneMeta', [milestone.id, { title: prefix + '-edited' }])).toBe(true)
  expect(await act(page, 'planning', 'updateProjectDates', [project.id, dates.start_date, dates.end_date])).toBe(true)
  expect(await act(page, 'planning', 'updateProcessDates', [processRow.id, dates.start_date, dates.end_date])).toBe(true)
  expect(await act(page, 'planning', 'updateMilestoneDate', [milestone.id, '2026-11-14'])).toBe(true)
  expect(await act(page, 'planning', 'createTaskComment', [task.id, 'Fixture comment'])).toBe(true)
  const comment = (await call('GET', `task/${task.id}/comments`))[0]
  expect(await act(page, 'planning', 'deleteTaskComment', [task.id, comment.id])).toBe(true)
  expect(await act(page, 'planning', 'createTask', [{ process_id: processRow.id, title: prefix + '-successor', start_date: '2026-11-16', end_date: '2026-11-22' }])).toBe(true)
  const successor = (await rows(page)).find(row => row.title === prefix + '-successor')
  expect(await act(page, 'planning', 'addTaskDependency', [successor.id, task.id, 'fs'])).toBe(true)
  const dependency = (await call('GET', 'planning/tasks')).processes.find(row => row.id === processRow.id).dependencies[0]
  expect(await act(page, 'planning', 'changeTaskDependencyType', [dependency.id, successor.id, 'ss'])).toBe(true)
  fault = { kind: 'lost', path: `/api/v1/task/${successor.id}` }
  expect(await act(page, 'planning', 'moveTask', [task.id, '2026-11-23', '2026-11-29'])).toBe(false)
  const cascadeKey = lost.key
  fault = null
  await page.locator('.ml-command-status button').filter({ hasText: 'Повторить отправку' }).click()
  await expect(page.locator('.ml-command-status')).toHaveCount(0)
  const cascadeRows = await rows(page)
  expect(cascadeRows.find(row => row.id === task.id).start_date).toBe('2026-11-23')
  expect(cascadeRows.find(row => row.id === successor.id).start_date).toBe('2026-11-23')
  expect(writes.filter(row => row.key === cascadeKey)).toHaveLength(2)
  report.push('PASS dependency cascade with a partially acknowledged prefix and lost final response: same child keys and complete confirmed dates after retry')
  expect(await act(page, 'planning', 'deleteTaskDependency', [dependency.id, successor.id])).toBe(true)
  expect(await act(page, 'planning', 'reorderTasks', [processRow.id, 0, 1])).toBe(true)
  expect(await act(page, 'planning', 'createProcess', [{ ...dates, project_id: project.id, owner_id: login.user.id, title: prefix + '-second' }])).toBe(true)
  await refresh(page)
  expect(await act(page, 'planning', 'reorderProcesses', [project.id, 0, 1])).toBe(true)
  expect((await act(page, 'planning', 'createProject', [{ ...dates, code: prefix + '-second' }])).ok).toBe(true)
  const project2 = (await call('GET', 'project?limit=500')).items.find(row => row.code === prefix + '-second'); projects.push(project2.id)
  await refresh(page)
  expect(await act(page, 'planning', 'reorderProjects', [0, 1])).toBe(true)
  await noQueue(page)
  expect(writes.every(row => !!row.key)).toBe(true)
  report.push('PASS online CRUD: projects, processes, tasks/subtasks, milestones, dependencies, resources/membership, timesheet, reorder, comments and accounts; all carry idempotency keys; no outbox writes')

  // A second tab shares the session, not an in-memory command lock.
  const sibling = await context.newPage(); await sibling.goto(web + '/planner'); await expect(sibling.locator('.ah-burger')).toBeVisible(); await runtime(sibling)
  fault = { kind: 'hold', path: `/api/v1/task/${task.id}` }
  const saving = act(page, 'planning', 'updateTaskMeta', [task.id, { title: prefix + '-held' }])
  await expect.poll(() => fault.hit).toBe(true)
  const duplicate = act(page, 'planning', 'updateTaskMeta', [task.id, { title: prefix + '-held' }])
  expect(await act(sibling, 'planning', 'updateTaskMeta', [successor.id, { title: prefix + '-other-tab' }])).toBe(true)
  await expect(sibling.locator('.ah-burger')).toBeVisible()
  release(); expect(await saving).toBe(true); expect(await duplicate).toBe(true); fault = null
  expect(writes.filter(row => row.body?.title === prefix + '-held')).toHaveLength(1)
  report.push('PASS pending write and double click in one tab do not block the second tab; exactly one request for duplicate clicks')

  for (const failure of [400, 403, 409, 500, 'timeout', 'offline']) {
    fault = typeof failure === 'number' ? { kind: 'reject', status: failure } : { kind: failure }
    const title = prefix + '-not-saved-' + failure
    expect(await act(page, 'planning', 'updateTaskMeta', [task.id, { title }])).toBe(false)
    expect((await rows(page)).find(row => row.id === task.id).title).not.toBe(title)
    await noQueue(page); await clearUnknown(page); fault = null
    expect((await call('GET', `task/${task.id}`)).title).not.toBe(title)
  }
  report.push('PASS 400/403/409/500/timeout/offline: finite failed result, no false saved state, no durable queue and no server mutation')

  fault = { kind: 'lost', path: '/api/v1/task' }
  const title = prefix + '-lost-response'
  expect(await act(page, 'planning', 'createTask', [{ process_id: processRow.id, title, start_date: '2026-11-23', end_date: '2026-11-29' }])).toBe(false)
  expect(lost?.key).toBeTruthy()
  await expect(page.locator('.ml-command-status')).toBeVisible()
  expect(await page.evaluate(() => window.fixture.commands.uncertainCommands.value[0]?.retryable)).toBe(true)
  fault = null
  await refresh(page)
  expect((await rows(page)).filter(row => row.title === title)).toHaveLength(1)
  await page.locator('.ml-command-status button').filter({ hasText: 'Повторить отправку' }).click()
  await expect(page.locator('.ml-command-status')).toHaveCount(0)
  expect(await page.evaluate(() => window.fixture.planning.error)).toBeNull()
  expect(writes.filter(row => row.body?.title === title).map(row => row.key)).toEqual([lost.key, lost.key])
  expect(await act(page, 'planning', 'createTask', [{ process_id: processRow.id, title, start_date: '2026-11-23', end_date: '2026-11-29' }])).toBe(true)
  expect(writes.filter(row => row.body?.title === title)).toHaveLength(2)
  expect((await rows(page)).filter(row => row.title === title)).toHaveLength(1)
  expect((await call('GET', 'planning/tasks')).processes.flatMap(row => row.tasks || []).filter(row => row.title === title)).toHaveLength(1)
  await noQueue(page)
  report.push('PASS actual backend commit with lost response, visible unknown status, manual same-key retry and one task in both UI and database')

  // Reload and reconnect must not resurrect failed commands as queued writes.
  await page.reload(); await runtime(page); await refresh(page); await noQueue(page)
  expect(await page.evaluate(() => window.fixture.commands.uncertainCommands.value)).toEqual([])
  expect(await act(page, 'planning', 'updateTaskDates', [task.id, '2026-11-10', '2026-11-16'])).toBe(true)
  report.push('PASS reload and recovery: no background replay of failed web commands; subsequent API editing succeeds')

  expect(await act(page, 'planning', 'deleteSubtask', [subtask.id])).toBe(true)
  expect(await act(page, 'planning', 'deleteTask', [successor.id])).toBe(true)
  expect(await act(page, 'planning', 'deleteMilestone', [milestone.id])).toBe(true)
  expect(await act(page, 'app', 'removeResourceMember', [resource.id, employee.user.id])).toBe(true)
  expect(await act(page, 'timesheet', 'deleteState', [state.id])).toBe(true); states.splice(states.indexOf(state.id), 1)
  expect(await act(page, 'app', 'deleteResource', [resource.id])).toBe(true); resources.splice(resources.indexOf(resource.id), 1)
  expect(await act(page, 'app', 'deleteUser', [employee.user.id])).toBe(true); users.splice(users.indexOf(employee.user.id), 1)
  expect(await act(page, 'planning', 'deleteProcess', [processRow.id])).toBe(true)
  expect(await act(page, 'planning', 'deleteProject', [project.id])).toBe(true); projects.splice(projects.indexOf(project.id), 1)
  await noQueue(page); await noQueue(sibling)
  expect(errors).toEqual([])
  console.log(report.join('\n')); console.log('PASS no uncaught browser errors; all web write paths stay out of the durable outbox')
} finally {
  release(); fault = null
  await context.close(); await browser.close()
  for (const id of projects.reverse()) await call('DELETE', `project/${id}`).catch(() => {})
  for (const id of resources) await call('DELETE', `resources/${id}`).catch(() => {})
  for (const id of states) await call('DELETE', `timesheet/states/${id}`).catch(() => {})
  for (const id of users) await call('DELETE', `user/${id}`).catch(() => {})
  await http.dispose()
}
