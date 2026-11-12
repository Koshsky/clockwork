import { chromium, expect, request } from 'playwright/test'

const web = process.env.ERP_TEST_URL, api = process.env.RBAC_TEST_API_URL
if (process.env.ERP_TEST_ISOLATED !== '1' || !web || !api || !process.env.RBAC_TEST_ADMIN_PASSWORD) throw new Error('An explicit isolated local API, web URL and password are required')
for (const url of [web, api]) if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local fixtures only')
const http = await request.newContext({ baseURL: api + '/' })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const contexts = [], resources = [], projects = [], users = [], errors = [], requests = [], report = []
const prefix = 'rd' + Date.now().toString(36)
const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
let token, stateId, subject
async function call(method, path, data) {
  for (let n = 0; n < 8; n++) {
    const response = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    if (!response.ok()) throw new Error(method + ' ' + path + ': ' + response.status() + ' ' + (await response.json())?.error?.message)
    return response.status() === 204 ? null : (await response.json()).data
  }
  throw new Error('Fixture rate limit did not recover')
}
async function open(username, password) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context)
  await context.addInitScript(origin => {
    if (location.origin !== origin) return
    localStorage.setItem('mvs_erp_auto_sync', '0'); localStorage.setItem('mvs_erp_ui_lang', 'ru')
    Object.defineProperty(window, 'indexedDB', { value: undefined })
  }, new URL(web).origin)
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)))
  context.on('request', req => {
    const url = new URL(req.url())
    if (url.pathname.startsWith('/api/v1/')) requests.push({ path: url.pathname, query: url.search, impersonation: req.headers()['x-view-user-id'] })
  })
  const page = await context.newPage(); page.setDefaultTimeout(20000)
  await page.goto(web + '/login')
  await page.locator('input[autocomplete=username]').fill(username)
  await page.locator('input[autocomplete=current-password]').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.locator('.ah-burger')).toBeVisible()
  return { page, context }
}
async function navigate(page, path) {
  const nav = page.locator('.nd')
  if (!/nd--open/.test(await nav.getAttribute('class'))) await page.locator('.ah-burger').click()
  const link = nav.locator(`a[href="${path}"]`)
  if (['/system/status', '/system/console', '/system/queue'].includes(path)) {
    await expect(link).toHaveCount(0)
    await page.goto(web + path); await expect(page).toHaveURL(/\/system\/settings$/)
    await expect(page.locator('.ah-burger')).toBeVisible()
    return
  }
  if (!await link.isVisible()) await link.locator('xpath=ancestor::section').locator('.nd-group-head').click()
  await link.click(); await expect(page).toHaveURL(new RegExp(path + '$'))
  await expect(link).toHaveClass(/active/)
}
async function storeState(page, domain) {
  return page.evaluate(async domain => {
    const store = await import('/src/store/index.ts')
    if (domain === 'planning') return { project: store.usePlanningStore().projectPlanning, process: store.usePlanningStore().processPlanning, task: store.usePlanningStore().taskPlanning, error: store.usePlanningStore().error, loading: store.usePlanningStore().loading }
    if (domain === 'resources') return { count: store.useAppStore().resources.length, total: store.useAppStore().resourcesTotal, error: store.useAppStore().resourcesError, more: store.useAppStore().resourcesHasMore }
    if (domain === 'timesheet') return { employees: store.useTimesheetStore().employees, states: store.useTimesheetStore().states, periods: store.useTimesheetStore().periodsByEmployee, error: store.useTimesheetStore().error }
    return { users: store.useAppStore().adminUsers, permissions: store.useRbacStore().myPermissions, profile: store.useAuthStore().user }
  }, domain)
}
try {
  const login = await call('POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD }); token = login.access_token
  subject = await call('POST', 'user', { username: prefix, first_name: 'Read', last_name: 'Fixture', preset: 'vp' }); users.push(subject.user.id)
  for (const owner of [subject.user.id, login.user.id]) {
    const project = await call('POST', 'project', { ...dates, code: prefix + '-p-' + owner, owner_id: owner }); projects.push(project.id)
    const process = await call('POST', 'process', { ...dates, title: prefix + '-process-' + owner, project_id: project.id, owner_id: owner })
    const task = await call('POST', 'task', { ...dates, title: prefix + '-task-' + owner, process_id: process.id, owner_id: owner })
    const resource = await call('POST', 'resources', { code: prefix + '-r-' + owner, title: prefix + '-resource-' + owner, owner_id: owner }); resources.push(resource.id)
    await call('POST', 'assignment', { task_id: task.id, resource_id: resource.id, quantity: 1 })
  }
  // More than the backend's maximum page size, with actual server pagination.
  for (let offset = 0; offset < 499; offset += 10) {
    await Promise.all(Array.from({ length: Math.min(10, 499 - offset) }, async (_, i) => {
      const resource = await call('POST', 'resources', { code: prefix + '-extra-' + (offset + i), title: prefix + '-extra-resource-' + (offset + i), owner_id: login.user.id }); resources.push(resource.id)
    }))
  }
  const state = await call('POST', 'timesheet/states', { code: prefix, name: prefix + '-leave', is_available: false }); stateId = state.id
  await call('POST', `resources/${resources[0]}/members`, { user_id: subject.user.id })
  await call('PUT', `user/${subject.user.id}/days`, { state_id: stateId, start_date: '2026-11-19', end_date: '2026-11-20' })
  const admin = await open('admin', process.env.RBAC_TEST_ADMIN_PASSWORD)
  await expect.poll(async () => (await admin.page.locator('.rs-code').allTextContents()).filter(code => code.startsWith(prefix)).length, { timeout: 30000 }).toBe(501)
  expect(requests.some(row => row.path === '/api/v1/resources' && row.query.includes('offset=500'))).toBe(true)
  report.push('PASS complete resource header: 501 server records, including page offset 500, with IndexedDB forbidden')
  await admin.page.locator('.pp-toolbar select').selectOption(String(subject.user.id))
  await expect.poll(async () => (await admin.page.locator('.rs-code').allTextContents()).filter(code => code.startsWith(prefix)).length).toBe(1)
  expect((await storeState(admin.page, 'planning')).task.processes.flatMap(p => p.tasks || []).filter(task => task.title.startsWith(prefix))).toHaveLength(2)
  expect(requests.every(row => !row.impersonation)).toBe(true)
  report.push('PASS resource-owner selector filters header rows without filtering tasks or impersonating users')
  for (const path of ['/projects', '/processes', '/resources', '/timesheet', '/employees', '/users', '/structure', '/auto-create', '/permissions', '/audit', '/system/settings', '/system/status', '/system/console', '/system/queue']) {
    await navigate(admin.page, path)
    await expect(admin.page.locator('.boot-splash')).toHaveCount(0)
    expect(errors, path).toEqual([])
  }
  report.push('PASS all navigation pages load through the API with IndexedDB forbidden')
  await navigate(admin.page, '/resources')
  await expect.poll(async () => (await storeState(admin.page, 'resources')).count).toBeGreaterThan(0)
  for (let n = 0; n < 12 && (await storeState(admin.page, 'resources')).more; n++) {
    const before = (await storeState(admin.page, 'resources')).count
    await admin.page.locator('.rp-more-btn').click()
    await expect.poll(async () => (await storeState(admin.page, 'resources')).count).toBeGreaterThan(before)
  }
  expect(await storeState(admin.page, 'resources')).toMatchObject({ count: 501, total: 501, more: false, error: null })
  report.push('PASS resource table loads all 501 rows through exact paginated API requests')
  await navigate(admin.page, '/timesheet')
  await expect.poll(async () => (await storeState(admin.page, 'timesheet')).periods[subject.user.id]?.length || 0).toBeGreaterThan(0)
  expect((await storeState(admin.page, 'timesheet')).error).toBeNull()
  for (const path of [`/users/${subject.user.id}/edit`, `/users/${subject.user.id}/edit/access`, '/users/new', '/profile']) {
    await admin.page.goto(web + path); await expect(admin.page).toHaveURL(new RegExp(path + '$')); await expect(admin.page.locator('.ah-burger')).toBeVisible()
    expect(errors, path).toEqual([])
  }
  report.push('PASS profile, user details, individual rights and creation forms work without local snapshots')
  await navigate(admin.page, '/projects'); await admin.page.goBack(); await admin.page.goForward()
  await expect(admin.page).toHaveURL(/\/projects$/)
  await admin.page.reload(); await expect(admin.page.locator('.ah-burger')).toBeVisible()
  const sibling = await admin.context.newPage(); await sibling.goto(web + '/processes'); await expect(sibling.locator('.ah-burger')).toBeVisible()
  await navigate(sibling, '/projects'); await sibling.close()
  report.push('PASS reload, back/forward and a second tab restore real API-backed sessions')
  const limited = await open(prefix, subject.password)
  await expect.poll(async () => (await limited.page.locator('.rs-code').allTextContents()).filter(code => code.startsWith(prefix)).length).toBe(1)
  const visible = (await storeState(limited.page, 'planning')).task.processes.flatMap(p => p.tasks || []).filter(task => task.title.startsWith(prefix))
  expect(visible).toHaveLength(1)
  await limited.page.goto(web + '/permissions'); await expect(limited.page).toHaveURL(/\/profile$/)
  report.push('PASS non-admin API scope and navigation: only owned resources and accessible planning, administration denied')
  // A cold failing API response must render an error rather than an empty project chart.
  const failure = await open('admin', process.env.RBAC_TEST_ADMIN_PASSWORD)
  await failure.context.route('**/api/v1/planning/projects', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 503, message: 'Read failure fixture' } }) }))
  await failure.page.goto(web + '/projects')
  await expect(failure.page).toHaveURL(/\/projects$/)
  await expect(failure.page.locator('body')).toContainText('Read failure fixture')
  expect((await storeState(failure.page, 'planning')).loading).toBe(false)
  await failure.context.unroute('**/api/v1/planning/projects')
  await failure.page.evaluate(async () => (await import('/src/store/index.ts')).usePlanningStore().refreshProjectPlanning())
  await expect.poll(async () => (await storeState(failure.page, 'planning')).project?.projects?.length || 0).toBeGreaterThan(0)
  expect((await storeState(failure.page, 'planning')).error).toBeNull()
  expect(errors).toEqual([])
  report.push('PASS API failure is explicit, loading terminates and retry restores data')
  console.log(report.join('\n'))
  const minute = await open('admin', process.env.RBAC_TEST_ADMIN_PASSWORD)
  await navigate(minute.page, '/projects')
  await minute.page.waitForLoadState('networkidle')
  await minute.page.evaluate(async () => {
    const { currentRuntime } = await import('/src/platform/current.ts')
    const runtime = currentRuntime.value
    if (!runtime) throw new Error('Web runtime is missing')
    runtime.stop()
    ;(await import('/src/settings.ts')).autoSync.value = true
    const fresh = (await import('/src/platform/web.ts')).createWebRuntime()
    currentRuntime.value = fresh
    await fresh.start()
  })
  const since = Date.now()
  const updatedCode = prefix + '-updated'
  await call('PUT', 'project/' + projects[0], { code: updatedCode })
  await expect.poll(async () => (await storeState(minute.page, 'planning')).project?.projects?.find(row => row.id === projects[0])?.project_code, { timeout: 75000, intervals: [1000] }).toBe(updatedCode)
  expect(Date.now() - since, 'the background minute must not be confused with page-entry refresh').toBeGreaterThanOrEqual(55000)
  expect(errors).toEqual([])
  console.log('PASS real minute synchronization: an external API change reaches the visible project without a reload')
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  for (const id of projects) await call('DELETE', 'project/' + id).catch(() => {})
  for (let offset = 0; offset < resources.length; offset += 10) await Promise.all(resources.slice(offset, offset + 10).map(id => call('DELETE', 'resources/' + id).catch(() => {})))
  if (subject && stateId) await call('DELETE', `user/${subject.user.id}/days?start_date=2026-11-19&end_date=2026-11-20&state_id=${stateId}`).catch(() => {})
  if (stateId) await call('DELETE', 'timesheet/states/' + stateId).catch(() => {})
  for (const id of users) await call('DELETE', 'user/' + id).catch(() => {})
  await browser.close(); await http.dispose()
}
