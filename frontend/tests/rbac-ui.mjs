import { chromium, expect, request } from 'playwright/test'
import { launchElectronFixture } from './helpers/electron.mjs'

const apiURL = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const webURL = process.env.RBAC_TEST_WEB_URL ?? 'http://127.0.0.1:5173'
for (const value of [apiURL, webURL]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw new Error('RBAC fixtures require loopback URLs')
}
if (!process.env.RBAC_TEST_ADMIN_PASSWORD) throw new Error('Set RBAC_TEST_ADMIN_PASSWORD for the local administrator')
const http = await request.newContext({ baseURL: apiURL.replace(/\/?$/, '/') })
const native = process.env.ERP_TEST_DESKTOP === '1' ? await launchElectronFixture() : null
const browser = native ? null : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
const context = native ? native.app.context() : await browser.newContext({ viewport: { width: 1440, height: 1000 } })
if (process.env.ERP_TEST_BLOCK_IDB === '1') await context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }))
const page = native ? await native.app.firstWindow() : await context.newPage()
const cleanup = [], errors = []
page.on('pageerror', error => errors.push(error.message))
let checks = 0, admin, uid
const prefix = `rbacui${Date.now()}`
const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const grant = (resource, action, scope = 'all') => ({ resource, action, scope, granted: true })
async function call(token, method, path, data) {
  for (let retry = 0; retry < 8; retry++) {
    const response = await http.fetch(path, { method, data, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    const text = await response.text()
    return { status: response.status(), ...(text ? JSON.parse(text) : {}) }
  }
  throw new Error('Persistent API rate limit')
}
function check(actual, expected, label) { expect(actual, label).toEqual(expected); checks++ }
async function create(path, body) {
  const result = await call(admin, 'POST', path, body)
  check(result.status, 201, `fixture ${path}`)
  const id = result.data.id
  cleanup.push(() => call(admin, 'DELETE', `${path}/${id}`))
  return id
}
async function rights(rules) {
  check((await call(admin, 'PUT', `rbac/users/${uid}/permissions`, { overrides: rules })).status, 200, 'save backend permissions')
  if (native) await page.evaluate(async () => window.erpDesktop.queue.request({ action: 'sync', force: true, pullOnly: true, contextId: (await window.erpDesktop.session.status()).contextId }))
  await expect.poll(() => page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().refreshPermissions()), { message: 'refresh real /permissions/me', timeout: 15_000, intervals: [1000] }).toBe(true)
  checks++
}
async function navigate(path) {
  await page.evaluate(path => window.rbacTestRouter.push(path), path)
}
async function loadPlanning(kind) {
  await page.evaluate(async kind => {
    const store = (await import('/src/store/index.ts')).usePlanningStore()
    await store[`refresh${kind}Planning`](true)
  }, kind)
  // Catalogue-driven layout updates can scroll the chart and close an open menu.
  await page.waitForLoadState('networkidle')
}
async function closeMenu() { await page.mouse.click(1400, 950); await page.keyboard.press('Escape') }
async function contextMenu(text, expected) {
  const bar = page.locator('.gantt-bar').filter({ hasText: text }).first()
  await expect(bar).toHaveCount(1)
  await bar.click({ button: 'right' })
  await expect(page.getByRole('menuitem')).toHaveText(expected)
  checks++
}
const protectedPages = ['/projects', '/processes', '/planner', '/resources', '/timesheet', '/employees', '/users', '/users/new', '/structure', '/auto-create', '/permissions', '/audit']
try {
  const login = await call(null, 'POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD })
  check(login.status, 200, 'administrator fixture login')
  admin = login.data.access_token
  const subject = await call(admin, 'POST', 'user', { username: prefix, first_name: 'RBAC', last_name: prefix, preset: 'worker' })
  check(subject.status, 201, 'disposable worker')
  uid = subject.data.user.id
  cleanup.push(() => call(admin, 'DELETE', `user/${uid}`))
  const project = await create('project', { ...dates, code: `${prefix}own`, owner_id: uid })
  const foreign = await create('project', { ...dates, code: `${prefix}other`, owner_id: login.data.user.id })
  const ownProcess = await create('process', { ...dates, title: `${prefix} process own`, project_id: project, owner_id: uid })
  const otherProcess = await create('process', { ...dates, title: `${prefix} process other`, project_id: foreign, owner_id: login.data.user.id })
  const task = await create('task', { ...dates, title: `${prefix} task own`, process_id: ownProcess, owner_id: uid })
  await create('task', { ...dates, title: `${prefix} task other`, process_id: otherProcess, owner_id: login.data.user.id })
  await create('task', { ...dates, title: `${prefix} subtask`, process_id: ownProcess, parent_id: task, owner_id: uid })
  const resource = await create('resources', { code: `${prefix}resource`, title: `${prefix} resource`, owner_id: uid })
  await create('assignment', { task_id: task, resource_id: resource, quantity: 1 })
  await create('milestone', { title: `${prefix} milestone`, content: 'RBAC', process_id: ownProcess, date: '2026-11-20' })
  await page.addInitScript(() => localStorage.setItem('mvs_erp_auto_sync', '0'))
  await page.goto(`${webURL}/login`)
  await page.locator('input[autocomplete=username]').fill(prefix)
  await page.locator('input[autocomplete=current-password]').fill(subject.data.password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await page.evaluate(async () => { window.rbacTestRouter = document.querySelector('#app').__vue_app__.config.globalProperties.$router })
  await rights([])
  for (const path of [...protectedPages, `/users/${uid}/edit`, `/users/${uid}/edit/access`]) {
    await navigate(path)
    await expect(page).toHaveURL(/\/profile$/)
    await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0)
    checks++
  }
  for (const [resource, paths] of [['project', ['/projects', '/processes', '/planner']], ['process', ['/processes', '/planner']], ['task', ['/planner']], ['worker', ['/timesheet', '/employees']], ['resource', ['/resources']], ['user_admin', ['/users']]]) {
    await rights([grant(resource, resource === 'rbac_config' ? 'update' : 'view')])
    for (const path of paths) {
      await navigate(path)
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      await expect(page.locator(`a[href="${path}"]`)).toHaveCount(1)
      checks++
    }
    await rights([])
    await expect(page).toHaveURL(/\/profile$/)
    checks++
  }
  for (const action of ['create', 'update', 'delete']) {
    await rights([grant('resource', action, 'self')])
    await navigate('/')
    await expect(page).toHaveURL(/\/resources$/)
    await expect(page.locator('a[href="/resources"]')).toHaveCount(1)
    await expect(page.locator('.rp-add')).toHaveCount(action === 'create' ? 1 : 0)
    checks++
  }
  // A view grant never opens a user mutation form, including via a direct URL.
  await rights([grant('user_admin', 'view')])
  for (const path of ['/users/new', `/users/${uid}/edit`, `/users/${uid}/edit/access`]) {
    await navigate(path); await expect(page).toHaveURL(/\/profile$/); checks++
  }
  for (const action of ['update', 'delete', 'create']) {
    await rights([grant('user_admin', 'view'), grant('worker', 'view'), grant('user_admin', action)])
    await navigate('/users')
    await expect(page.locator('.up-add')).toHaveCount(action === 'create' ? 1 : 0)
    const row = page.locator('.dt-tr').filter({ hasText: prefix }).first()
    await expect(row).toHaveCount(1)
    await row.dispatchEvent('contextmenu', { button: 2, bubbles: true, clientX: 650, clientY: 400 })
    await expect(page.getByRole('menuitem')).toHaveCount(action === 'create' ? 0 : 1)
    await closeMenu(); checks++
  }
  // The same worker gains only the requested scoped action; the preset is unchanged.
  for (const action of ['update', 'delete']) {
    await rights([grant('project', 'view'), grant('project', action, 'self')])
    await navigate('/projects'); await loadPlanning('Project')
    await contextMenu(`${prefix}own`, [action === 'delete' ? 'Удалить проект' : 'Редактировать'])
    await closeMenu()
    await contextMenu(`${prefix}other`, [])
    await closeMenu()
  }
  await rights([grant('project', 'view'), grant('project', 'update', 'self')])
  await navigate('/projects'); await loadPlanning('Project')
  await contextMenu(`${prefix}own`, ['Редактировать'])
  await page.getByRole('menuitem', { name: 'Редактировать', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await rights([grant('project', 'view')])
  await expect(page.getByRole('dialog')).toHaveCount(0)
  checks++
  for (const action of ['update', 'delete']) {
    await rights([grant('project', 'view'), grant('process', action, 'process_owner')])
    await navigate('/processes'); await loadPlanning('Process')
    await contextMenu(`${prefix} process own`, [action === 'delete' ? 'Удалить процесс' : 'Редактировать'])
    await closeMenu()
    await contextMenu(`${prefix} process other`, [])
    await closeMenu()
    await expect(page.locator('.gantt-bar').filter({ hasText: `${prefix} process own` }).locator('.gb-handle')).toHaveCount(action === 'update' ? 2 : 0)
    await expect(page.locator('.gantt-bar').filter({ hasText: `${prefix} process other` }).locator('.gb-handle')).toHaveCount(0)
  }
  await rights([grant('project', 'view'), grant('task', 'view', 'up1')])
  await navigate('/planner'); await loadPlanning('Task')
  await expect(page.locator('.gantt-bar').filter({ hasText: `${prefix} task other` })).toHaveCount(1)
  checks++
  for (const action of ['update', 'delete']) {
    await rights([grant('project', 'view'), grant('task', action, 'process_owner')])
    await navigate('/planner'); await loadPlanning('Task')
    await contextMenu(`${prefix} task own`, action === 'delete' ? ['Комментарии', 'Удалить задачу'] : ['Комментарии', 'Редактировать'])
    await closeMenu()
    await contextMenu(`${prefix} task other`, ['Комментарии'])
    await closeMenu()
    await expect(page.locator('.gantt-bar').filter({ hasText: `${prefix} task own` }).locator('.gb-handle')).toHaveCount(action === 'update' ? 2 : 0)
    await expect(page.locator('.gantt-bar').filter({ hasText: `${prefix} task other` }).locator('.gb-handle')).toHaveCount(0)
    await expect(page.locator('.ms-marker[role=slider]')).toHaveCount(0)
  }
  await rights([grant('project', 'view'), grant('milestone', 'update', 'process_owner')])
  await expect(page.locator('.gantt-bar .gb-handle')).toHaveCount(0)
  await expect(page.locator('.ms-marker[role=slider]')).toHaveCount(1)
  for (const action of ['create', 'delete']) {
    await rights([grant('project', 'view'), grant('resource', 'view'), grant('assignment', action, 'process_owner')])
    await contextMenu(`${prefix} task own`, ['Комментарии', 'Управление ресурсами'])
    await page.getByRole('menuitem', { name: 'Управление ресурсами', exact: true }).click()
    await expect(page.locator('.rm-body')).toBeVisible()
    await expect(page.locator('.rm-add')).toHaveCount(action === 'create' ? 1 : 0)
    await expect(page.locator('.rm-remove')).toHaveCount(action === 'delete' ? 1 : 0)
    await rights([grant('project', 'view')])
    await expect(page.locator('.rm-add, .rm-remove')).toHaveCount(0)
    await page.keyboard.press('Escape')
    checks++
  }
  await rights([])
  await expect(page).toHaveURL(/\/profile$/)
  await page.reload()
  await expect(page).toHaveURL(/\/profile$/)
  check(errors, [], 'no browser runtime errors')
  console.log(`PASS RBAC UI: ${checks} checks; real backend grants, complete pages, direct URLs, inherited view, independent actions, object owners and live revocation`)
} finally {
  if (native) await native.close()
  else await browser.close()
  for (const remove of cleanup.reverse()) await remove()
  await http.dispose()
}
