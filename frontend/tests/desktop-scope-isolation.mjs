import { _electron, expect } from 'playwright/test'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'

const targets = [process.env.ERP_TEST_API_A, process.env.ERP_TEST_API_B]
const passwords = [process.env.ERP_TEST_PASSWORD_A, process.env.ERP_TEST_PASSWORD_B]
if (process.env.ERP_TEST_ISOLATED !== '1' || !process.env.ERP_TEST_ARTIFACT || !process.env.ELECTRON_EXECUTABLE || targets.some(value => !value || !['localhost', '127.0.0.1'].includes(new URL(value).hostname)) || passwords.some(value => !value) || targets[0] === targets[1]) throw new Error('Two distinct isolated local APIs and a prebuilt test ASAR are required')
const prefix = 'scope' + randomUUID().slice(0, 8), profile = mkdtempSync(path.join(tmpdir(), 'clockwork-scope-'))
const servers = targets.map((target, index) => ({ target, password: passwords[index], label: index ? 'B' : 'A', requests: [], offline: false, hold: null, token: null, project: null }))
const errors = [], report = []
let native, worker
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const mark = value => { report.push(value); console.log('PASS', value) }
async function direct(server, method, route, body) {
  const response = await fetch(server.target + '/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(server.token ? { Authorization: 'Bearer ' + server.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error(`Scope fixture ${server.label} ${method} ${route}: ${response.status}`)
  return response.status === 204 ? null : (await response.json()).data
}
async function proxy(server, request, response) {
  if (server.offline) return response.destroy()
  try {
    const parts = []; for await (const part of request) parts.push(part)
    const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length']
    const row = { method: request.method, route: request.url, operation: headers['operation-id'] }
    server.requests.push(row)
    const result = await fetch(server.target + request.url, { method: request.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Buffer.concat(parts) }) })
    const body = Buffer.from(await result.arrayBuffer()), outgoing = {}
    for (const [key, value] of result.headers) if (!['content-length', 'connection', 'transfer-encoding', 'content-encoding', 'set-cookie'].includes(key)) outgoing[key] = value
    if (server.hold && request.method === 'GET' && request.url === '/api/v1/planning/tasks' && result.status === 200) {
      const held = server.hold; server.hold = null; held.started.resolve(); await held.release.promise
    }
    if (!response.destroyed) { response.writeHead(result.status, outgoing); response.end(body) }
  } catch { response.destroy() }
}
const address = server => 'http://127.0.0.1:' + server.proxy.address().port
async function queue(page, action, extra = {}) {
  return page.evaluate(async ({ action, extra }) => window.erpDesktop.queue.request({ action, ...extra, contextId: (await window.erpDesktop.session.status()).contextId }), { action, extra })
}
async function list(page) {
  const rows = []; let after = 0
  for (;;) { const result = await queue(page, 'list', { after }); rows.push(...result.items); if (result.complete) return rows; after = result.after }
}
async function login(page, origin, username, password) {
  await page.goto(origin + '/login')
  await page.locator('input[autocomplete=username]').fill(username)
  await page.locator('input[autocomplete=current-password]').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await queue(page, 'configure', { autoSync: false })
}
async function hydrate(pages, server) {
  await queue(pages[0], 'sync', { force: true, pullOnly: true })
  await Promise.all(pages.map(page => page.goto(new URL(page.url()).origin + '/planner')))
  for (const page of pages) await expect(page.locator('.gantt-bar').filter({ hasText: prefix + server.label }).first()).toBeVisible({ timeout: 15000 })
}
let held
try {
  for (const server of servers) {
    server.proxy = createServer((request, response) => void proxy(server, request, response))
    await new Promise(resolve => server.proxy.listen(0, '127.0.0.1', resolve))
    const session = await direct(server, 'POST', '/auth/login', { username: 'admin', password: server.password }); server.token = session.access_token
    server.accountId = session.user.id
    const dates = { start_date: '2026-11-01', end_date: '2026-11-30' }
    server.project = await direct(server, 'POST', '/project', { ...dates, code: prefix + server.label, owner_id: session.user.id })
    const process = await direct(server, 'POST', '/process', { ...dates, title: prefix + server.label + ' process', owner_id: session.user.id, project_id: server.project.id })
    server.task = await direct(server, 'POST', '/task', { ...dates, title: prefix + server.label + ' task', owner_id: session.user.id, process_id: process.id })
  }
  const [a, b] = servers
  expect(a.accountId).toBe(b.accountId)
  expect(a.task.id).toBe(b.task.id)
  worker = await direct(a, 'POST', '/user', { username: prefix + 'worker', first_name: 'Scope', last_name: 'Worker', preset: 'worker' })
  const env = { ...process.env, ERP_ARTIFACT_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
  native = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE, args: [process.env.ERP_TEST_ARTIFACT], env })
  const first = await native.firstWindow(); first.setDefaultTimeout(15000)
  await expect.poll(() => native.evaluate(() => Boolean(globalThis.artifactFixture))).toBe(true)
  await native.context().addInitScript(server => {
    if (!['http:', 'https:'].includes(location.protocol)) return
    localStorage.setItem('mvs_erp_ui_lang', 'ru')
    if (!localStorage.getItem('mvs_erp_api_url')) localStorage.setItem('mvs_erp_api_url', server + '/api/v1')
    localStorage.setItem('mvs_erp_auto_sync', '0')
    Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Renderer IndexedDB must remain unused') } })
  }, address(a))
  native.context().on('page', page => { page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)) })
  first.on('pageerror', error => errors.push(error.message))
  const origin = await native.evaluate(() => globalThis.artifactFixture.origin)
  await login(first, origin, 'admin', a.password)
  await hydrate([first], a)
  await native.evaluate(() => { globalThis.artifactFixture.createWindow(globalThis.artifactFixture.origin + '/planner'); globalThis.artifactFixture.createWindow(globalThis.artifactFixture.origin + '/planner') })
  await expect.poll(() => native.windows().length).toBe(3)
  const pages = native.windows(), controller = pages.at(-1)
  for (const page of pages) await expect(page.locator('.gantt-bar').filter({ hasText: prefix + 'A' }).first()).toBeVisible()
  a.offline = true
  await first.locator('.gantt-bar').filter({ hasText: prefix + 'A' }).first().dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 650, clientY: 400 })
  await first.getByRole('menuitem', { name: 'Редактировать', exact: true }).click()
  await first.locator('.te-left input').fill(prefix + 'A pending')
  await first.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
  await expect.poll(async () => (await list(first)).length).toBe(1)
  await first.locator('.te-footer .te-cancel').click()
  const operation = (await list(first))[0], identity = { operationId: operation.operationId, input: operation.input }
  for (const page of pages) expect((await list(page))[0].operationId).toBe(operation.operationId)
  mark('three compiled desktop windows share the exact durable intent without renderer IndexedDB')

  a.offline = false
  held = { started: deferred(), release: deferred() }; a.hold = held
  const late = first.evaluate(async () => {
    const state = await window.erpDesktop.session.status()
    try { await window.erpDesktop.session.api({ operation: 'GET /planning/tasks', requestId: crypto.randomUUID(), contextId: state.contextId }); return 'accepted' }
    catch (error) { return error.message }
  }); late.catch(() => {})
  await held.started.promise
  await controller.evaluate(() => window.erpDesktop.session.logout())
  await login(controller, origin, prefix + 'worker', worker.password)
  for (const page of pages) {
    expect((await page.evaluate(() => window.erpDesktop.session.status())).user.id).toBe(worker.user.id)
    expect(await list(page)).toEqual([])
    await expect(page.locator('.gantt-bar').filter({ hasText: prefix + 'A' })).toHaveCount(0)
    const cached = await queue(page, 'cacheGet', { key: address(a) + '/api/v1/planning/tasks' })
    expect(JSON.stringify(cached) || '').not.toContain(prefix + 'A')
  }
  mark('changing accounts hides the prior account cache and pending queue in all three windows')

  await controller.evaluate(async server => { localStorage.setItem('mvs_erp_api_url', server + '/api/v1'); await window.erpDesktop.session.selectServer(server) }, address(b))
  await login(controller, origin, 'admin', b.password)
  await hydrate(pages, b)
  held.release.resolve()
  expect(await late).toMatch(/SESSION_CONTEXT_CHANGED|SESSION_|Target.*closed|cancel/i)
  for (const page of pages) { expect(await list(page)).toEqual([]); await expect(page.locator('.gantt-bar').filter({ hasText: prefix + 'A' })).toHaveCount(0) }
  expect(b.requests.some(row => row.operation === operation.operationId)).toBe(false)
  mark('server change isolates identical account/object IDs and rejects a late response from the previous server')

  await controller.evaluate(async server => { localStorage.setItem('mvs_erp_api_url', server + '/api/v1'); await window.erpDesktop.session.selectServer(server) }, address(a))
  expect((await controller.evaluate(() => window.erpDesktop.session.status())).user.id).toBe(worker.user.id)
  expect(await list(controller)).toEqual([])
  await controller.evaluate(() => window.erpDesktop.session.logout())
  await login(controller, origin, 'admin', a.password)
  expect((await list(controller)).map(row => ({ operationId: row.operationId, input: row.input }))).toEqual([identity])
  await queue(controller, 'retry', { operationId: operation.operationId }); await queue(controller, 'push')
  await expect.poll(async () => (await list(controller)).length).toBe(0)
  expect((await direct(a, 'GET', '/task/' + a.task.id)).title).toBe(prefix + 'A pending')
  expect((await direct(b, 'GET', '/task/' + b.task.id)).title).toBe(prefix + 'B task')
  expect(a.requests.filter(row => row.method === 'PUT' && row.operation === operation.operationId)).toHaveLength(1)
  expect(b.requests.some(row => row.operation === operation.operationId)).toBe(false)
  mark('returning to the original server/account restores the unchanged operation and delivers it once to the correct backend')
  await controller.goto(origin + '/planner')
  await expect(controller.locator('.gantt-bar').filter({ hasText: prefix + 'A pending' }).first()).toBeVisible()
  await native.evaluate(({ session }, directory) => {
    globalThis.scopeDownloads = []
    session.defaultSession.on('will-download', (_, item) => {
      const destination = directory + '/export-' + globalThis.scopeDownloads.length + '.pdf'
      item.setSavePath(destination)
      item.once('done', (_, state) => globalThis.scopeDownloads.push({ path: destination, state }))
    })
  }, profile)
  for (const [unit, label] of [['day', 'День'], ['week', 'Неделя']]) {
    const header = controller.locator('.tg-head'), box = await header.boundingBox()
    await header.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: box.x + 300, clientY: box.y + 10 })
    await controller.getByRole('menuitem', { name: new RegExp(label + '$') }).click()
    const before = await controller.locator('.tg-scroll').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop, zoom: el.querySelector('.tg-content').style.zoom }))
    await controller.keyboard.press('Control+s')
    await expect.poll(() => controller.locator('.pe-pages canvas').count(), { timeout: 30000 }).toBeGreaterThan(0)
    await expect(controller.locator('.pe-btn-download')).toBeEnabled()
    const count = await native.evaluate(() => globalThis.scopeDownloads.length)
    await controller.locator('.pe-btn-download').click()
    await expect.poll(() => native.evaluate(() => globalThis.scopeDownloads.length), { timeout: 30000 }).toBe(count + 1)
    const download = await native.evaluate(() => globalThis.scopeDownloads.at(-1))
    expect(download.state).toBe('completed')
    const pdf = await PDFDocument.load(readFileSync(download.path)); expect(pdf.getPageCount()).toBeGreaterThan(0)
    await expect(controller.locator('.pe-modal')).toHaveCount(0)
    expect(await controller.locator('.tg-scroll').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop, zoom: el.querySelector('.tg-content').style.zoom }))).toEqual(before)
    await controller.keyboard.press('Control+p')
    await expect(controller.locator('.pe-btn-primary')).toBeEnabled({ timeout: 30000 })
    await controller.evaluate(() => {
      window.scopePrintCalls = 0
      const create = document.createElement.bind(document)
      document.createElement = function (tag, ...args) {
        const element = create(tag, ...args)
        if (tag === 'iframe') queueMicrotask(() => { if (element.contentWindow) element.contentWindow.print = () => { window.scopePrintCalls++; element.contentWindow.dispatchEvent(new Event('afterprint')) } })
        return element
      }
    })
    await controller.locator('.pe-btn-primary').click()
    await expect.poll(() => controller.evaluate(() => window.scopePrintCalls)).toBe(1)
    await expect(controller.locator('.pe-modal')).toHaveCount(0)
    mark('compiled desktop ' + unit + ' PDF, Ctrl+S/Ctrl+P and print handoff work without changing source position or scale')
  }
  expect(errors).toEqual([])
  console.log(JSON.stringify({ groups: report.length, report }))
} catch (error) {
  console.error(error)
  throw error
} finally {
  held?.release.resolve()
  for (const server of servers) server.offline = false
  if (native) await native.close()
  if (worker) await direct(servers[0], 'DELETE', '/user/' + worker.user.id)
  for (const server of servers) {
    if (server.project) await direct(server, 'DELETE', '/project/' + server.project.id)
    if (server.proxy) await new Promise(resolve => { server.proxy.close(resolve); server.proxy.closeAllConnections() })
  }
  rmSync(profile, { recursive: true, force: true })
}
