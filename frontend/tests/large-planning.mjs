import { chromium, _electron, expect } from 'playwright/test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createStaticHandler } = require('../desktop/static-server.cjs')
const api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
const webDir = process.env.ERP_TEST_WEB_ARTIFACT, artifact = process.env.ERP_TEST_ARTIFACT
const sourceURL = process.env.ERP_TEST_SOURCE_URL
if (process.env.ERP_TEST_ISOLATED !== '1' || !api || !password || !webDir || !artifact || !process.env.ELECTRON_EXECUTABLE || !['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('Explicit isolated local API, existing web/ASAR and Electron runtime are required')
if (sourceURL && !['127.0.0.1', 'localhost'].includes(new URL(sourceURL).hostname)) throw new Error('Source acceptance requires an isolated local Vite URL')
if (JSON.parse(readFileSync(path.join(webDir, 'build-target.json'), 'utf8')).target !== 'web' || !existsSync(artifact)) throw new Error('Existing compiled platform artifacts are required')

// Local failure ceilings are declared before seeding or measuring, not inferred from a passing run.
const budget = { coldReadyMs: 20000, interactionMs: 5000, domNodes: 90000, jsHeapBytes: 256 * 1024 * 1024 }
const size = { tasks: 600, resources: 60, processes: 12, projects: 2, days: 90 }
console.log('BUDGET', JSON.stringify({ budget, size, resourceCells: 'resources * (max(ceil((viewportWidth / scale - 180) / cellWidth), 1) + 2)' }))
const prefix = 'large' + randomUUID().slice(0, 8)
const startDay = new Date(); startDay.setHours(0, 0, 0, 0); startDay.setDate(startDay.getDate() - ((startDay.getDay() + 6) % 7))
const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const add = (date, days) => { const value = new Date(date + 'T00:00:00'); value.setDate(value.getDate() + days); return iso(value) }
const from = iso(startDay), to = add(from, size.days - 1), absentDay = add(from, 2), spikeDay = add(from, 3)
const dates = { start_date: from, end_date: to }
const users = [], projects = [], processes = [], resources = [], tasks = [], report = [], calls = [], budgetFailures = []
let token, state, employee, browser, native, profile, heapDiagnostic, absencePresent = false, functionalComplete = false
const mark = (mode, message, metrics = {}) => { report.push({ mode, message, ...metrics }); console.log('PASS', mode, message, JSON.stringify(metrics)) }
function latency(label, elapsed, ceiling) {
 if (elapsed < ceiling) return
 const failure = { label, elapsed, ceiling }; budgetFailures.push(failure); console.error('BUDGET FAILURE', JSON.stringify(failure))
}
async function direct(method, route, body) {
 for (let attempt = 0; attempt < 8; attempt++) {
  const response = await fetch(api + '/api/v1' + route, { method, signal: AbortSignal.timeout(budget.coldReadyMs), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
  if (!response.ok) throw new Error('Large-planning fixture ' + method + ' ' + route + ': ' + response.status)
  return response.status === 204 ? null : (await response.json()).data
 }
 throw new Error('Large-planning fixture rate limit did not recover')
}
async function bounded(items, work) {
 let next = 0
 const results = await Promise.allSettled(Array.from({ length: Math.min(8, items.length) }, async () => {
  for (;;) { const index = next++; if (index >= items.length) return; await work(items[index], index) }
 }))
 const failed = results.find(result => result.status === 'rejected')
 if (failed) throw failed.reason
}
async function absence(present) {
 if (present) await direct('PUT', '/user/' + employee.id + '/days', { state_id: state.id, start_date: absentDay, end_date: absentDay })
 else await direct('DELETE', `/user/${employee.id}/days?start_date=${absentDay}&end_date=${absentDay}&state_id=${state.id}`)
 absencePresent = present
}
const staticHandler = createStaticHandler(webDir)
const server = createServer(async (request, response) => {
 if (!request.url.startsWith('/api/v1/')) return staticHandler(request, response)
 try {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
  calls.push({ method: request.method, path: request.url, impersonation: headers['x-view-user-id'] })
  const upstream = await fetch(api + request.url, { method: request.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) })
  const bytes = Buffer.from(await upstream.arrayBuffer()), outgoing = {}
  for (const [key, value] of upstream.headers) if (!['content-length', 'connection', 'transfer-encoding', 'content-encoding', 'set-cookie'].includes(key)) outgoing[key] = value
  const cookies = upstream.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies
  response.writeHead(upstream.status, outgoing); response.end(bytes)
 } catch { response.destroy() }
})
const origin = () => 'http://127.0.0.1:' + server.address().port
async function queue(page, action, extra = {}) {
 return page.evaluate(async ({ action, extra }) => window.erpDesktop.queue.request({ action, ...extra, contextId: (await window.erpDesktop.session.status()).contextId }), { action, extra })
}
async function store(page, action = 'snapshot') {
 return page.evaluate(async action => {
  const app = document.querySelector('#app').__vue_app__
  const pinia = Reflect.ownKeys(app._context.provides).map(key => app._context.provides[key]).find(value => value?._s instanceof Map)
  const planning = pinia._s.get('planning'), data = pinia._s.get('app')
  if (action === 'calendar') await data.refreshCalendar()
  return { processes: planning.taskPlanning?.processes || [], calendar: data.calendar, error: planning.error, calendarError: data.calendarError }
 }, action)
}
async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function metrics(page) {
 return page.evaluate(() => {
  const scroll = document.querySelector('.tg-scroll'), cells = [...document.querySelectorAll('.rs-cell')]
  const scale = Number(document.querySelector('.tg-content').style.zoom || 1), width = parseFloat(cells[0].style.width)
  const rows = document.querySelectorAll('.rs-row').length
  return { domNodes: document.querySelectorAll('*').length, jsHeapBytes: performance.memory?.usedJSHeapSize ?? null, resourceCells: cells.length, cellCeiling: rows * (Math.max(Math.ceil((scroll.clientWidth / scale - 180) / width), 1) + 2), rows, width, scale }
 })
}
async function boundedDOM(page, mode, label) {
 const value = await metrics(page)
 expect(value.resourceCells, mode + ' ' + label + ' horizontally virtualized cells').toBeLessThanOrEqual(value.cellCeiling)
 expect(value.domNodes, mode + ' ' + label + ' DOM ceiling').toBeLessThanOrEqual(budget.domNodes)
 expect(value.jsHeapBytes, 'Chromium exposes the measured JS heap').not.toBeNull()
 if (value.jsHeapBytes > budget.jsHeapBytes) {
  const failure = { label: mode + ' ' + label + ' heap ceiling', actual: value.jsHeapBytes, ceiling: budget.jsHeapBytes }
  budgetFailures.push(failure); console.error('BUDGET FAILURE', JSON.stringify(failure))
 }
 return value
}
async function scrollDate(page, date, unit) {
 const started = performance.now()
 await expect.poll(async () => {
  await page.locator('.tg-scroll').evaluate((scroll, { date, unit }) => {
   const cell = document.querySelector('.rs-cell'), first = cell.dataset.date
   const delta = (Date.parse(date + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / 86400000 / (unit === 'week' ? 7 : 1)
   const scale = Number(document.querySelector('.tg-content').style.zoom || 1)
   scroll.scrollLeft = (parseFloat(cell.style.left) + delta * parseFloat(cell.style.width) - 180) * scale
   scroll.dispatchEvent(new Event('scroll'))
  }, { date, unit })
  await frame(page)
  return page.locator('.rs-cell').first().getAttribute('data-date')
 }, { timeout: budget.interactionMs }).toBe(date)
 await frame(page)
 const elapsed = performance.now() - started
 latency(unit + ' horizontal scroll', elapsed, budget.interactionMs)
 return elapsed
}
async function unit(page, name) {
 const started = performance.now()
 await page.locator('.th-corner').click({ button: 'right', position: { x: 20, y: 15 } })
 await page.getByRole('menuitem', { name: new RegExp(name + '$') }).click()
 await frame(page)
 const elapsed = performance.now() - started
 latency('calendar unit change', elapsed, budget.interactionMs)
 return elapsed
}
async function cells(page) {
 return page.evaluate(() => [...document.querySelectorAll('.rs-cell')].map(row => ({ id: Number(row.dataset.resourceId), date: row.dataset.date, text: row.querySelector('.uc-inner')?.textContent?.trim() })))
}
async function assertPlanning(page) {
 const actual = await store(page), selected = actual.processes.filter(process => process.title.startsWith(prefix))
 expect(actual.error).toBeNull(); expect(actual.calendarError).toBeNull()
 expect(selected.map(row => row.id).sort((a, b) => a - b)).toEqual(processes.map(row => row.id).sort((a, b) => a - b))
 expect([...new Set(selected.map(row => row.project_id))].sort((a, b) => a - b)).toEqual(projects.map(row => row.id).sort((a, b) => a - b))
 expect(selected.flatMap(row => row.tasks || []).map(row => row.id).sort((a, b) => a - b)).toEqual(tasks.map(row => row.id).sort((a, b) => a - b))
 expect(selected.flatMap(row => row.tasks || []).reduce((sum, row) => sum + row.resources.length, 0)).toBe(size.tasks)
 const rowIds = await page.locator('.gg-row[data-pdf-row]').evaluateAll(rows => rows.map(row => Number(row.dataset.pdfRow)).sort((a, b) => a - b))
 expect(rowIds).toEqual(tasks.map(row => row.id).sort((a, b) => a - b))
}
async function verifyCalendarAPI(present) {
 const calendar = await direct('GET', `/timesheet/calendar?start_date=${from}&end_date=${to}`)
 const selected = calendar.resources.filter(row => resources.some(resource => resource.id === row.resource_id))
 expect(selected).toHaveLength(size.resources)
 for (const resource of selected) for (const day of [from, absentDay, spikeDay, to]) {
  const period = resource.periods.find(period => period.start_date <= day && period.end_date >= day)
  expect(period.available, resource.resource_id + ' backend ' + day).toBe(present && resource.resource_id === resources[0].id && day === absentDay ? 0 : 1)
 }
}
async function verifyView(mode, page, errors) {
 const start = performance.now()
 await page.goto((sourceURL || (mode === 'web' ? origin() : await native.evaluate(() => globalThis.artifactFixture.origin))) + '/login')
 await page.locator('input[autocomplete=username]').fill('admin')
 await page.locator('input[autocomplete=current-password]').fill(password)
 await page.locator('button[type=submit]').click()
 await page.waitForURL(url => url.pathname !== '/login', { timeout: budget.coldReadyMs })
 if (mode === 'desktop') { await queue(page, 'configure', { autoSync: false }); await queue(page, 'sync', { force: true, pullOnly: true }) }
 const pageOrigin = new URL(page.url()).origin
 await page.goto(pageOrigin + '/planner?process=' + processes[0].id)
 await expect(page.locator('.rs-row')).toHaveCount(size.resources, { timeout: budget.coldReadyMs })
 await expect(page.locator('.gg-row[data-pdf-row]')).toHaveCount(size.tasks, { timeout: budget.coldReadyMs })
 await expect(page.locator(`.rs-cell[data-date="${from}"] .uc-inner`).first()).toHaveText('1/1', { timeout: budget.coldReadyMs })
 await frame(page)
 const coldReadyMs = performance.now() - start
 latency(mode + ' cold diagram load', coldReadyMs, budget.coldReadyMs)
 await assertPlanning(page)
 const covered = new Set(), scrollMs = []
 let target = from
 for (let window = 0; window < size.days && target <= to; window++) {
  scrollMs.push(await scrollDate(page, target, 'day'))
  const windowCells = await cells(page)
  for (const date of new Set(windowCells.map(cell => cell.date))) expect(windowCells.filter(cell => cell.date === date).map(cell => cell.id).sort((a, b) => a - b), mode + ' complete resource column ' + date).toEqual(resources.map(resource => resource.id).sort((a, b) => a - b))
  for (const cell of windowCells) {
   if (cell.date < from || cell.date > to) continue
   expect(cell.text, mode + ' resource ' + cell.id + ' day ' + cell.date).toBe(`${cell.date === spikeDay ? 10 : 1}/${cell.id === resources[0].id && cell.date === absentDay ? 0 : 1}`)
   covered.add(cell.id + ':' + cell.date)
  }
  const last = windowCells.map(cell => cell.date).sort().at(-1)
  expect(last >= target, 'horizontal window advances').toBe(true)
  await boundedDOM(page, mode, 'day window ' + window)
  target = add(last, 1)
 }
 expect(covered.size, mode + ' every resource/day checked').toBe(size.resources * size.days)
 mark(mode, 'real API-backed 600-task/60-resource diagram has correct usage and absence availability for all 5400 resource-days', { coldReadyMs, scrollMs, ...(await boundedDOM(page, mode, 'day')) })
 await scrollDate(page, from, 'day')
 const weekMs = await unit(page, 'Неделя')
 await scrollDate(page, from, 'week')
 const weekCells = (await cells(page)).filter(cell => cell.date >= from && cell.date <= to)
 expect(weekCells).toHaveLength(size.resources * Math.ceil(size.days / 7))
 for (const cell of weekCells) expect(cell.text, mode + ' week ' + cell.date).toBe(cell.date === from ? `10/${cell.id === resources[0].id ? 0 : 1}` : '1/1')
 expect(await page.locator(`.rs-cell[data-date="${from}"] .uc-inner`).first().textContent()).not.toBe('1/1')
 mark(mode, 'weekly cells show Thursday peak and Wednesday minimum instead of Monday; all 13 weeks are checked', { weekMs, ...(await boundedDOM(page, mode, 'week')) })
 await unit(page, 'День'); await scrollDate(page, from, 'day')
 const firstTask = tasks.find(task => task.resourceIndex === 0 && task.slot === 0)
 const foreignTask = tasks.find(task => task.resourceIndex === 30 && task.slot === 0)
 const taskRow = id => page.locator(`.gg-row[data-pdf-row="${id}"]`)
 const selector = page.locator('.pp-toolbar select')
 expect(await selector.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean).sort())).toEqual(users.slice(0, 2).map(user => String(user.id)).sort())
 for (const owner of [users[0], users[1], null]) {
  const started = performance.now()
  await selector.selectOption(owner ? String(owner.id) : '')
  await expect(page.locator('.rs-row')).toHaveCount(owner ? 30 : 60, { timeout: budget.interactionMs })
  await frame(page)
  latency(mode + ' resource-only filter', performance.now() - started, budget.interactionMs)
  const expectedCodes = resources.filter(resource => !owner || resource.owner_id === owner.id).map(resource => resource.code).sort()
  expect((await page.locator('.rs-code').allTextContents()).sort()).toEqual(expectedCodes)
  await expect(taskRow(firstTask.id).locator('.tb-badge')).toHaveCount(!owner || owner.id === users[0].id ? 1 : 0)
  await expect(taskRow(foreignTask.id).locator('.tb-badge')).toHaveCount(!owner || owner.id === users[1].id ? 1 : 0)
  await assertPlanning(page); await boundedDOM(page, mode, 'owner filter')
 }
 expect(calls.every(call => !call.impersonation)).toBe(true)
 mark(mode, 'owner selection filters only resource header rows and bar badges; all 600 tasks, 12 processes and two projects remain intact')
 await absence(false); await verifyCalendarAPI(false)
 if (mode === 'desktop') await queue(page, 'sync', { force: true, pullOnly: true })
 await store(page, 'calendar')
 await expect(page.locator(`.rs-cell[data-date="${absentDay}"] .uc-inner`).first()).toHaveText('1/1', { timeout: budget.interactionMs })
 for (const cell of await cells(page)) {
  if (cell.date < from || cell.date > to) continue
  expect(cell.text).toBe(`${cell.date === spikeDay ? 10 : 1}/1`)
 }
 await unit(page, 'Неделя'); await scrollDate(page, from, 'week')
 for (const cell of (await cells(page)).filter(cell => cell.date >= from && cell.date <= to)) expect(cell.text).toBe(cell.date === from ? '10/1' : '1/1')
 await assertPlanning(page)
 expect(errors).toEqual([])
 mark(mode, 'deleting the real absence restores availability only on its day and updates weekly minimum without changing assignments or demand')
 await absence(true)
}

try {
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
 token = (await direct('POST', '/auth/login', { username: 'admin', password })).access_token
 for (const suffix of ['owner-a', 'owner-b']) {
  const result = await direct('POST', '/user', { username: prefix + 'u' + users.length, first_name: 'Planning', last_name: suffix, preset: 'vp' })
  users.push(result.user)
 }
 for (let index = 0; index < size.projects; index++) projects.push(await direct('POST', '/project', { ...dates, owner_id: users[index].id, code: prefix + '-p' + index }))
 for (let index = 0; index < size.processes; index++) processes.push(await direct('POST', '/process', { ...dates, owner_id: users[Math.floor(index / 6)].id, project_id: projects[Math.floor(index / 6)].id, title: prefix + '-process-' + index }))
 await bounded(Array.from({ length: size.resources }, (_, index) => index), async index => {
  const resource = await direct('POST', '/resources', { owner_id: users[Math.floor(index / 30)].id, code: prefix + '-r' + String(index).padStart(2, '0'), title: prefix + '-resource-' + index })
  resources.push({ ...resource, index })
  const member = await direct('POST', '/user', { username: prefix + 'e' + index, first_name: 'Planning', last_name: 'Employee' + index, preset: 'worker' })
  users.push(member.user)
  if (index === 0) employee = member.user
  await direct('POST', '/resources/' + resource.id + '/members', { user_id: member.user.id })
 })
 resources.sort((a, b) => a.index - b.index)
 state = await direct('POST', '/timesheet/states', { code: prefix, name: prefix + '-absence', is_available: false })
 await absence(true)
 // Keep this UI workload independent of the backend's concurrent append-order conflict behavior.
 await bounded(processes, async (process, processIndex) => {
  for (let offset = 0; offset < 50; offset++) {
   const index = processIndex * 50 + offset, resourceIndex = Math.floor(index / 10), slot = index % 10, resource = resources[resourceIndex]
   const task = await direct('POST', '/task', { owner_id: resource.owner_id, process_id: process.id, title: prefix + '-task-' + String(index).padStart(3, '0'), ...(slot === 0 ? dates : { start_date: spikeDay, end_date: spikeDay }) })
   tasks.push({ ...task, resourceIndex, slot })
   await direct('POST', '/assignment', { task_id: task.id, resource_id: resource.id, quantity: 1 })
  }
 })
 await verifyCalendarAPI(true)
 const planning = await direct('GET', '/planning/tasks')
 expect(planning.processes.filter(process => process.title.startsWith(prefix)).flatMap(process => process.tasks || [])).toHaveLength(size.tasks)
 console.log('FIXTURES', JSON.stringify({ ...size, from, to, absentDay, spikeDay, employees: 60, api: 'real backend', availability: 'real distinct employees, resource memberships and one isolated absence' }))
 browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
 const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' })
 await context.addInitScript(() => {
  if (!['http:', 'https:'].includes(location.protocol)) return
  localStorage.setItem('mvs_erp_ui_lang', 'ru'); localStorage.setItem('mvs_erp_auto_sync', '0')
  localStorage.setItem('mvs_erp_view_settings', JSON.stringify({ badgeResource: true, defaultUnit: 'day' }))
  Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Compiled web must not use IndexedDB') } })
 })
 const page = await context.newPage(), webErrors = []; page.setDefaultTimeout(budget.coldReadyMs)
 page.on('pageerror', error => webErrors.push(error.message))
 await verifyView('web', page, webErrors)
 await browser.close(); browser = null
 profile = mkdtempSync(path.join(tmpdir(), 'clockwork-large-planning-'))
 const env = { ...process.env, ERP_ARTIFACT_PROFILE: profile, ...(sourceURL ? { ERP_CSP_USER_DATA: profile, ERP_TEST_URL: sourceURL } : {}) }; delete env.ELECTRON_RUN_AS_NODE
 native = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE, args: sourceURL ? [fileURLToPath(new URL('./electron-main.cjs', import.meta.url))] : [artifact], env })
 await native.context().addInitScript(apiURL => {
  if (!['http:', 'https:'].includes(location.protocol)) return
  localStorage.setItem('mvs_erp_ui_lang', 'ru'); localStorage.setItem('mvs_erp_auto_sync', '0')
  localStorage.setItem('mvs_erp_view_settings', JSON.stringify({ badgeResource: true, defaultUnit: 'day' }))
  localStorage.setItem('mvs_erp_api_url', apiURL + '/api/v1')
  Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Compiled desktop renderer must not use IndexedDB') } })
 }, origin())
 const desktop = await native.firstWindow(), desktopErrors = []; desktop.setDefaultTimeout(budget.coldReadyMs)
 desktop.on('pageerror', error => desktopErrors.push(error.message))
 if (!sourceURL) await expect.poll(() => native.evaluate(() => Boolean(globalThis.artifactFixture))).toBe(true)
 await desktop.setViewportSize({ width: 1440, height: 1000 })
 await verifyView('desktop', desktop, desktopErrors)
 functionalComplete = true
 if (process.env.ERP_TEST_HEAP_DIAGNOSTICS === '1') {
  const session = await native.context().newCDPSession(desktop)
  try {
   await session.send('Performance.enable')
   const heap = async () => (await session.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'JSHeapUsedSize').value
   const before = await heap()
   await session.send('HeapProfiler.collectGarbage')
   heapDiagnostic = { before, after: await heap(), scope: 'Electron source renderer after all functional and raw budget measurements; diagnostic only' }
   console.log('HEAP DIAGNOSTIC', JSON.stringify(heapDiagnostic))
  } finally { await session.detach() }
 }
 console.log(JSON.stringify({ cases: report.length, renderer: sourceURL ? 'source Vite, no build' : 'existing compiled web and ASAR', budget, size, report, budgetFailures }))
 expect(budgetFailures, 'predeclared performance ceilings').toEqual([])
} finally {
 const cleanupErrors = []
 if (native) { try { await native.close() } catch (error) { cleanupErrors.push(error.message) } }
 if (browser) { try { await browser.close() } catch (error) { cleanupErrors.push(error.message) } }
 const remove = async route => { try { await direct('DELETE', route) } catch (error) { cleanupErrors.push(error.message) } }
 if (absencePresent) { try { await absence(false) } catch (error) { cleanupErrors.push(error.message) } }
 for (const project of projects) await remove('/project/' + project.id)
 for (const resource of resources) await remove('/resources/' + resource.id)
 for (const user of users) await remove('/user/' + user.id)
 if (state) await remove('/timesheet/states/' + state.id)
 if (profile) rmSync(profile, { recursive: true, force: true })
 await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
 if (process.env.ERP_TEST_REPORT) writeFileSync(process.env.ERP_TEST_REPORT, JSON.stringify({ cases: report.length, functionalComplete, renderer: sourceURL ? 'source Vite, no build' : 'existing compiled web and ASAR', budget, size, report, budgetFailures, heapDiagnostic, cleanupErrors }, null, 2) + '\n', { mode: 0o600 })
 expect(cleanupErrors, 'all owned API fixtures are cleaned up').toEqual([])
}
