import { chromium, expect } from 'playwright/test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const { createStaticHandler } = require('../desktop/static-server.cjs')
const api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD, webDir = process.env.ERP_TEST_WEB_ARTIFACT
if (process.env.ERP_TEST_ISOLATED !== '1' || !api || !password || !webDir || !['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('Explicit isolated API and existing compiled web are required')
if (JSON.parse(readFileSync(path.join(webDir, 'build-target.json'), 'utf8')).target !== 'web') throw new Error('A compiled web artifact is required')
const candidates = {
 chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 yandex: '/Applications/Yandex.app/Contents/MacOS/Yandex',
}
const browserNames = (process.env.ERP_TEST_BROWSERS || 'chrome,yandex').split(',')
for (const name of browserNames) if (!candidates[name] || !existsSync(candidates[name])) throw new Error('Requested installed browser is unavailable: ' + name)
const prefix = 'matrix' + randomUUID().slice(0, 8), dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const report = [], calls = [], faults = [], cleanup = []
let admin, browser
const mark = (name, message, metrics = {}) => { report.push({ browser: name, message, ...metrics }); console.log('PASS', name, message, JSON.stringify(metrics)) }
async function within(promise, label) {
 let timer
 try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 15000) })]) }
 finally { clearTimeout(timer) }
}
async function direct(method, route, body) {
 const result = await fetch(api + '/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: 'Bearer ' + admin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
 if (!result.ok) throw new Error('Fixture ' + method + ' ' + route + ': ' + result.status)
 return result.status === 204 ? null : (await result.json()).data
}
function fault(properties) {
 let release
 const value = { active: true, hit: false, ...properties, wait: new Promise(resolve => { release = resolve }), release: () => { value.active = false; release() } }
 faults.push(value); return value
}
const staticHandler = createStaticHandler(webDir)
const server = createServer(async (request, response) => {
 if (!request.url.startsWith('/api/v1/')) return staticHandler(request, response)
 try {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks), headers = { ...request.headers }, tab = headers['x-stage18-tab']
  delete headers.host; delete headers.connection; delete headers['content-length']
  const row = { method: request.method, path: request.url, tab, key: headers['idempotency-key'] }
  if (request.method === 'PUT' && request.url.startsWith('/api/v1/task/')) row.title = JSON.parse(body.toString()).title
  calls.push(row)
  const selected = faults.find(value => value.active && (!value.tab || value.tab === tab) && (!value.method || value.method === request.method) && value.path === request.url && (!value.title || value.title === row.title))
  const upstream = await fetch(api + request.url, { method: request.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(request.method) ? {} : { body }) })
  let bytes = Buffer.from(await upstream.arrayBuffer()), status = upstream.status
  row.status = status; row.replayed = upstream.headers.get('Idempotency-Replayed') === 'true'
  const outgoing = {}
  for (const [key, value] of upstream.headers) if (!['content-length', 'connection', 'transfer-encoding', 'set-cookie', 'content-encoding'].includes(key)) outgoing[key] = value
  const cookies = upstream.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies
  if (selected) {
   selected.hit = true; selected.upstreamStatus = status
   if (selected.kind === 'hold') await selected.wait
   if (selected.kind === 'lost') return response.destroy()
   if (selected.kind === 'status') { status = selected.status; bytes = Buffer.from(JSON.stringify({ data: null, error: { code: status, message: 'Isolated partial hydration refusal' } })) }
   if (selected.kind === 'structure') bytes = Buffer.from(JSON.stringify({ data: selected.employees, error: {} }))
  }
  if (!response.destroyed) { response.writeHead(status, outgoing); response.end(bytes) }
 } catch { response.destroy() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const stores = page => page.evaluate(() => {
 const app = document.querySelector('#app').__vue_app__
 const pinia = Reflect.ownKeys(app._context.provides).map(key => app._context.provides[key]).find(value => value?._s instanceof Map)
 return { authenticated: pinia._s.get('auth').isAuthenticated, userId: pinia._s.get('auth').user?.id, loading: pinia._s.get('planning')?.loading, error: pinia._s.get('planning')?.error }
})
async function refresh(page) {
 return page.evaluate(async () => {
  const app = document.querySelector('#app').__vue_app__
  const pinia = Reflect.ownKeys(app._context.provides).map(key => app._context.provides[key]).find(value => value?._s instanceof Map)
  await pinia._s.get('planning').refreshTaskPlanning(true)
 })
}
async function taskTitle(page, id) {
 return page.evaluate(id => {
  const app = document.querySelector('#app').__vue_app__
  const pinia = Reflect.ownKeys(app._context.provides).map(key => app._context.provides[key]).find(value => value?._s instanceof Map)
  return pinia._s.get('planning').taskPlanning.processes.flatMap(process => process.tasks || []).find(task => task.id === id).title
 }, id)
}
async function login(page, username = 'admin', secret = password) {
 await page.goto(origin + '/login')
 await page.locator('input[autocomplete=username]').fill(username)
 await page.locator('input[autocomplete=current-password]').fill(secret)
 await page.locator('button[type=submit]').click()
 await expect(page.locator('.ah-burger')).toBeVisible({ timeout: 15000 })
}
async function navigate(page, route, timeout = 2000) {
 const started = Date.now()
 if (!await page.locator('.nd').evaluate(element => element.classList.contains('nd--open'))) await page.locator('.ah-burger').click()
 await expect(page.locator('.nd')).toHaveClass(/nd--open/)
 await page.locator('.nd a[href="' + route + '"]').click()
 await expect(page).toHaveURL(origin + route, { timeout })
 expect(Date.now() - started, 'navigation including drawer and route transition').toBeLessThan(timeout)
}
async function edit(page, from, to) {
 const bar = page.locator('.gantt-bar').filter({ hasText: from }).first()
 await expect(bar).toBeVisible()
 await bar.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 650, clientY: 400 })
 await page.getByRole('menuitem', { name: 'Редактировать', exact: true }).click()
 await page.locator('.te-left input').fill(to)
 await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
}
async function contextFor(browser, errors) {
 const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 1000 } })
 await context.addInitScript(expectedOrigin => {
  if (location.origin !== expectedOrigin) return
  localStorage.setItem('mvs_erp_auto_sync', '0'); localStorage.setItem('mvs_erp_ui_lang', 'ru')
  window.idbTouches = 0
  Object.defineProperty(window, 'indexedDB', { get() { window.idbTouches++; throw new Error('Compiled web must not access IndexedDB') } })
 }, origin)
 context.on('page', page => { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)) })
 return context
}
try {
 const authentication = await direct('POST', '/auth/login', { username: 'admin', password }); admin = authentication.access_token
 const account = await direct('POST', '/user', { username: prefix, first_name: 'Other', last_name: 'Matrix', preset: 'worker' })
 cleanup.push(() => direct('DELETE', '/user/' + account.user.id))
 await direct('PUT', '/rbac/users/' + account.user.id + '/permissions', { overrides: [{ resource: 'project', action: 'view', scope: 'self', granted: true }] })
 const own = await direct('POST', '/project', { code: prefix + '-admin', owner_id: authentication.user.id, ...dates })
 const other = await direct('POST', '/project', { code: prefix + '-other', owner_id: account.user.id, ...dates })
 cleanup.push(() => direct('DELETE', '/project/' + own.id), () => direct('DELETE', '/project/' + other.id))
 const processRow = await direct('POST', '/process', { project_id: own.id, title: prefix + '-admin', owner_id: authentication.user.id, ...dates })
 const otherProcess = await direct('POST', '/process', { project_id: other.id, title: prefix + '-other', owner_id: account.user.id, ...dates })
 const task = await direct('POST', '/task', { process_id: processRow.id, title: prefix + '-start', owner_id: authentication.user.id, ...dates })
 const second = await direct('POST', '/task', { process_id: processRow.id, title: prefix + '-second', owner_id: authentication.user.id, ...dates })
 await direct('POST', '/task', { process_id: otherProcess.id, title: prefix + '-private-B', owner_id: account.user.id, ...dates })
 for (const name of browserNames) {
  browser = await chromium.launch({ executablePath: candidates[name], headless: true })
  console.log('BROWSER', name, await browser.version())
  const errors = [], context = await contextFor(browser, errors), pages = []
  for (const tab of ['A', 'B', 'C']) {
   const page = await context.newPage(); await page.setExtraHTTPHeaders({ 'X-Stage18-Tab': name + tab }); pages.push(page)
  }
  const [a, b, c] = pages, start = prefix + '-' + name + '-start'
  await direct('PUT', '/task/' + task.id, { title: start })
  await direct('PUT', '/task/' + second.id, { title: prefix + '-second' })
  await login(a)
  for (const page of [b, c]) { await page.goto(origin + '/planner'); await expect(page.locator('.gantt-bar').filter({ hasText: start }).first()).toBeVisible() }
  await expect(a.locator('.gantt-bar').filter({ hasText: start }).first()).toBeVisible()
  await a.waitForLoadState('networkidle')
  const oldRead = fault({ tab: name + 'A', method: 'GET', path: '/api/v1/planning/tasks', kind: 'hold' })
  const reading = refresh(a)
  await expect.poll(() => oldRead.hit).toBe(true); expect(oldRead.upstreamStatus).toBe(200)
  const pendingTitle = prefix + '-' + name + '-confirmed', heldWrite = fault({ tab: name + 'A', method: 'PUT', path: '/api/v1/task/' + task.id, title: pendingTitle, kind: 'hold' })
  await edit(a, start, pendingTitle)
  await expect.poll(() => heldWrite.hit).toBe(true); expect(heldWrite.upstreamStatus).toBe(200)
  await expect(a.locator('.te-spinner')).toBeVisible()
  await navigate(c, '/projects'); await navigate(c, '/processes'); await navigate(c, '/planner')
  await edit(b, prefix + '-second', prefix + '-' + name + '-independent')
  await expect.poll(async () => (await direct('GET', '/task/' + second.id)).title).toBe(prefix + '-' + name + '-independent')
  await b.locator('.te-footer .te-cancel').click()
  heldWrite.release(); await expect(a.locator('.te-spinner')).toHaveCount(0)
  await expect(a.locator('.gantt-bar').filter({ hasText: pendingTitle }).first()).toBeVisible()
  oldRead.release(); await reading
  await expect(a.locator('.gantt-bar').filter({ hasText: pendingTitle }).first()).toBeVisible()
  expect((await direct('GET', '/task/' + task.id)).title).toBe(pendingTitle)
  await a.locator('.te-footer .te-cancel').click()
  mark(name, 'three tabs: old real GET cannot overwrite a confirmed UI edit; pending save never blocks other tab edits or navigation')

  const lostTitle = prefix + '-' + name + '-lost', lost = fault({ tab: name + 'A', method: 'PUT', path: '/api/v1/task/' + task.id, title: lostTitle, kind: 'lost' })
  await edit(a, pendingTitle, lostTitle)
  await expect(a.locator('.te-footer [role=alert]')).toBeVisible()
  expect(lost.upstreamStatus).toBe(200); expect((await direct('GET', '/task/' + task.id)).title).toBe(lostTitle)
  lost.release()
  await a.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
  await expect(a.locator('.te-spinner')).toHaveCount(0)
  await expect(a.locator('.te-footer [role=alert]')).toHaveCount(0)
  await expect.poll(() => calls.filter(row => row.title === lostTitle).at(-1)?.replayed).toBe(true)
  const attempts = calls.filter(row => row.title === lostTitle)
  expect(attempts.length).toBeGreaterThanOrEqual(2); expect(new Set(attempts.map(row => row.key)).size).toBe(1)
  expect(attempts[0].key).toBeTruthy(); expect(attempts.filter(row => !row.replayed)).toHaveLength(1); expect(attempts.at(-1).replayed).toBe(true)
  await a.locator('.te-footer .te-cancel').click()
  mark(name, 'lost committed UI save stays explicit; manual retry preserves key and replays exactly one mutation')

  await a.waitForLoadState('networkidle')
  const lateRead = fault({ tab: name + 'A', method: 'GET', path: '/api/v1/planning/tasks', kind: 'hold' }), oldSessionRead = refresh(a)
  await expect.poll(() => lateRead.hit).toBe(true)
  await refresh(b)
  const lateTitle = prefix + '-' + name + '-late-A', lateWrite = fault({ tab: name + 'B', method: 'PUT', path: '/api/v1/task/' + task.id, title: lateTitle, kind: 'hold' })
  await edit(b, await taskTitle(b, task.id), lateTitle); await expect.poll(() => lateWrite.hit).toBe(true)
  await c.locator('.ah-act--logout').click()
  await expect.poll(async () => (await stores(a)).authenticated).toBe(false)
  await expect.poll(async () => (await stores(b)).authenticated).toBe(false)
  await login(c, account.user.username, account.password)
  lateRead.release(); lateWrite.release(); await within(oldSessionRead.catch(() => {}), 'old-session read settles after logout')
  await navigate(c, '/planner')
  await expect(c.locator('.gantt-bar').filter({ hasText: prefix + '-private-B' }).first()).toBeVisible()
  for (const page of [a, b]) { await page.goto(origin + '/planner'); await expect(page.locator('.gantt-bar').filter({ hasText: prefix + '-private-B' }).first()).toBeVisible() }
  for (const page of pages) {
   expect((await stores(page)).userId).toBe(account.user.id)
   expect(await page.locator('.gantt-bar').filter({ hasText: lateTitle }).count()).toBe(0)
   expect(await page.evaluate(() => window.idbTouches)).toBe(0)
   expect(await page.locator('.ml-command-status').count()).toBe(0)
  }
  expect((await direct('GET', '/task/' + task.id)).title).toBe(lateTitle)
  mark(name, 'three-tab logout and account switch fence late old-account GET/write results; no session resurrection, foreign bars or browser queue')
  await context.close()

  for (const status of [403, 404, 503]) {
   const partial = await contextFor(browser, errors), page = await partial.newPage(), tab = name + 'partial' + status
   await page.setExtraHTTPHeaders({ 'X-Stage18-Tab': tab })
   const refusal = fault({ tab, method: 'GET', path: '/api/v1/planning/tasks', kind: 'status', status })
   await login(page); await expect.poll(() => refusal.hit).toBe(true)
   await expect.poll(async () => (await stores(page)).loading).toBe(false)
   await expect(page.locator('.pg-error, .st.er').first()).toBeVisible()
   await navigate(page, '/projects'); await expect(page.locator('.gantt-bar').filter({ hasText: prefix + '-admin' }).first()).toBeVisible()
   refusal.release(); await navigate(page, '/planner')
   await expect(page.locator('.gantt-bar').filter({ hasText: lateTitle }).first()).toBeVisible()
   expect(await page.evaluate(() => window.idbTouches)).toBe(0)
   await partial.close()
   mark(name, 'partial planning ' + status + ' finishes with an error, leaves unrelated navigation usable and recovers after retry')
  }

  const large = await contextFor(browser, errors), page = await large.newPage(), tab = name + 'large'
  await page.setExtraHTTPHeaders({ 'X-Stage18-Tab': tab }); await login(page)
  const employees = Array.from({ length: 2047 }, (_, index) => ({ id: 100000 + index, manager_id: index ? 100000 + Math.floor((index - 1) / 2) : undefined, name: 'Manager ' + String(index).padStart(4, '0'), username: 'manager' + index, position: 'Fixture' }))
  employees.push(...Array.from({ length: 50 }, (_, index) => ({ id: 200000 + index, manager_id: 100000, last_name: 'Team' + String(index).padStart(2, '0'), first_name: 'First', middle_name: index % 2 ? undefined : 'Middle' })))
  const structure = fault({ tab, method: 'GET', path: '/api/v1/user/structure', kind: 'structure', employees })
  const before = Date.now(); await navigate(page, '/structure')
  await expect(page.locator('.oc-node')).toHaveCount(3, { timeout: 10000 })
  const renderMs = Date.now() - before; expect(renderMs).toBeLessThan(10000)
  const root = page.locator('.oc-node').filter({ has: page.locator('.oc-name', { hasText: 'Manager 0000' }) })
  await expect(root.locator('.ot-person')).toHaveCount(2)
  await root.locator('.ot-more').click(); await expect(root.locator('.ot-person')).toHaveCount(5)
  const height = await root.evaluate(element => element.getBoundingClientRect().height)
  for (let i = 0; i < 9; i++) await root.locator('.ot-pagination button:last-child').click()
  await expect(root.locator('.ot-pagination')).toContainText('46–50')
  expect(await root.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
  await root.locator('.oc-person').click()
  await expect(page.locator('.oc-details h3')).toHaveText('Manager 0000')
  const child = page.locator('.oc-node').filter({ has: page.locator('.oc-name', { hasText: 'Manager 0001' }) })
  await child.locator('.oc-branch').click()
  await expect.poll(() => page.locator('.oc-node').count()).toBeGreaterThan(3)
  expect(await page.locator('.oc-node').count()).toBeLessThan(50)
  await page.locator('.cs-switch button').filter({ hasText: 'Таблица' }).click()
  await expect(page.locator('.cs-pagination')).toContainText('21')
  await expect(page.locator('.cs .dt-tr:not(.dt-th)')).toHaveCount(100)
  const firstRow = await page.locator('.cs .dt-tr:not(.dt-th)').first().textContent()
  await page.locator('.cs-pagination button:last-child').click()
  await expect(page.locator('.cs .dt-tr:not(.dt-th)')).toHaveCount(100)
  await expect(page.locator('.cs .dt-tr:not(.dt-th)').first()).not.toHaveText(firstRow)
  await page.locator('.cs-switch button').filter({ hasText: 'Схема' }).click()
  await expect(page.locator('.oc-details h3')).toHaveText('Manager 0000')
  await expect(page.locator('.oc-node').filter({ has: page.locator('.oc-name', { hasText: 'Manager 0000' }) }).locator('.ot-pagination')).toContainText('46–50')
  expect(await page.evaluate(() => window.idbTouches)).toBe(0)
  expect(structure.upstreamStatus).toBe(200)
  await large.close()
  mark(name, 'compiled large-company route: 1023 manager candidates, 50-person team, bounded chart DOM, expand/select/table pagination and restored card state', { employees: employees.length, renderMs, fixture: 'real authenticated GET with synthetic stress response' })
  expect(errors).toEqual([])
  await browser.close(); browser = null
 }
 console.log(JSON.stringify({ cases: report.length, browsers: browserNames, report }, null, 2))
} catch (error) {
 console.error('Matrix failed:', error)
 throw error
} finally {
 for (const entry of faults) entry.release()
 if (browser) await browser.close()
 for (const undo of cleanup.reverse()) await undo()
 await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
}
