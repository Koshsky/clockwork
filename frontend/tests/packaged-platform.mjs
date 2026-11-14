import { chromium, _electron, expect } from 'playwright/test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url)
const { createStaticHandler } = require('../desktop/static-server.cjs')
const { readVersion } = require('../scripts/app-version.cjs')
const api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
const artifact = process.env.ERP_TEST_ARTIFACT, webDir = process.env.ERP_TEST_WEB_ARTIFACT
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !api || !artifact || !webDir || !['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('Isolated API, compiled web and test ASAR are required')
const manifests = [JSON.parse(readFileSync(path.join(webDir, 'build-target.json'), 'utf8'))]
const prefix = 'artifact' + randomUUID().slice(0, 8), profile = mkdtempSync(path.join(tmpdir(), 'clockwork-artifact-'))
const errors = [], report = [], requests = []
let token, project, task, native, browser, offline = false, loseTitle = null, sustainedLoss = false
async function direct(method, route, body) {
 const response = await fetch(api + '/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
 if (!response.ok) throw new Error('Artifact fixture ' + method + ' ' + route + ': ' + response.status)
 return response.status === 204 ? null : (await response.json()).data
}
async function forward(request, response) {
 if (offline) return response.destroy()
 try {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks), headers = { ...request.headers }
  delete headers.host; delete headers.connection; delete headers['content-length']
  const row = { method: request.method, path: request.url, operation: headers['operation-id'], key: headers['idempotency-key'] }
  if (request.method === 'PUT' && request.url === '/api/v1/task/' + task?.id) row.title = JSON.parse(body.toString()).title
  requests.push(row)
  const result = await fetch(api + request.url, { method: request.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(request.method) ? {} : { body }) })
  if (row.title) row.replayed = result.headers.get('Idempotency-Replayed') === 'true'
  const bytes = Buffer.from(await result.arrayBuffer()), outgoing = {}
  for (const [key, value] of result.headers) if (!['content-length', 'connection', 'transfer-encoding', 'set-cookie', 'content-encoding'].includes(key)) outgoing[key] = value
  const cookies = result.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies
  if (loseTitle && request.method === 'PUT' && request.url === '/api/v1/task/' + task.id && JSON.parse(body.toString()).title === loseTitle && result.ok) { if (!sustainedLoss) loseTitle = null; return response.destroy() }
  response.writeHead(result.status, outgoing); response.end(bytes)
 } catch { response.destroy() }
}
const proxy = createServer(forward), staticHandler = createStaticHandler(webDir)
const web = createServer((request, response) => request.url.startsWith('/api/v1/') ? void forward(request, response) : staticHandler(request, response))
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server => 'http://127.0.0.1:' + server.address().port
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
const mark = message => { report.push(message); console.log('PASS', message) }
async function queue(page, action, extra = {}) {
 return page.evaluate(async ({ action, extra }) => window.erpDesktop.queue.request({ action, ...extra, contextId: (await window.erpDesktop.session.status()).contextId }), { action, extra })
}
async function queueRows(page) {
 const rows = []; let after = 0
 for (;;) { const batch = await queue(page, 'list', { after }); rows.push(...batch.items); if (batch.complete) return rows; after = batch.after }
}
async function edit(page, title) {
 const bar = page.locator('.gantt-bar').filter({ hasText: prefix }).first()
 await expect(bar).toBeVisible()
 await bar.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 650, clientY: 400 })
 await page.getByRole('menuitem', { name: 'Редактировать', exact: true }).click()
 await page.locator('.te-left input').fill(title)
 await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
}
async function login(page, origin, waitForRows = true) {
 await page.goto(origin + '/login')
 await page.locator('input[autocomplete=username]').fill('admin')
 await page.locator('input[autocomplete=current-password]').fill(password)
 await page.locator('button[type=submit]').click()
 await expect(page).not.toHaveURL(/\/login/)
 if (waitForRows) await expect(page.locator('.gantt-bar').filter({ hasText: prefix }).first()).toBeVisible({ timeout: 20000 })
}
async function launchNative() {
 const env = { ...process.env, ERP_ARTIFACT_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
 native = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE, args: [artifact], env })
 native.process().stderr.on('data', data => process.stderr.write(data))
 const page = await native.firstWindow()
 page.setDefaultTimeout(20000)
 await expect.poll(() => native.evaluate(() => Boolean(globalThis.artifactFixture))).toBe(true)
 const context = native.context()
 await context.addInitScript(apiURL => { localStorage.setItem('mvs_erp_ui_lang', 'ru'); localStorage.setItem('mvs_erp_api_url', apiURL + '/api/v1'); localStorage.setItem('mvs_erp_auto_sync', '0'); Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Renderer IndexedDB must not be used') } }) }, address(proxy))
 page.on('pageerror', error => errors.push(error.message))
 const origin = await native.evaluate(() => globalThis.artifactFixture.origin)
 await page.goto(origin + '/login')
 return { page, origin }
}
try {
 await listen(proxy); await listen(web)
 token = (await direct('POST', '/auth/login', { username: 'admin', password })).access_token
 const me = (await direct('POST', '/auth/login', { username: 'admin', password })).user
 const dates = { start_date: '2026-11-01', end_date: '2026-11-30' }
 project = await direct('POST', '/project', { code: prefix, owner_id: me.id, ...dates })
 const processRow = await direct('POST', '/process', { title: prefix + ' process', project_id: project.id, owner_id: me.id, ...dates })
 task = await direct('POST', '/task', { title: prefix + ' task', process_id: processRow.id, owner_id: me.id, ...dates })
 browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
 const context = await browser.newContext()
 await context.addInitScript(() => {
  localStorage.setItem('mvs_erp_ui_lang', 'ru')
  window.idbTouches = 0
  Object.defineProperty(window, 'indexedDB', { get() { window.idbTouches++; throw new Error('Built web must not use IndexedDB') } })
  window.erpDesktop = { isElectron: true, service: { businessProtocol: 1, status() { throw new Error('Built web used an injected native bridge') } } }
  localStorage.setItem('mvs_erp_auto_sync', '0')
 })
 const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
 await login(page, address(web))
 await expect(page.locator('a[href="/login/settings"]')).toHaveCount(0)
 await edit(page, prefix + ' web confirmed')
 await expect.poll(async () => (await direct('GET', '/task/' + task.id)).title).toBe(prefix + ' web confirmed')
 await page.locator('.te-footer .te-cancel').click()
 sustainedLoss = true; loseTitle = prefix + ' web unknown'
 await edit(page, loseTitle)
 await expect(page.locator('.te-footer [role=alert]')).toBeVisible()
 await expect.poll(async () => (await direct('GET', '/task/' + task.id)).title).toBe(prefix + ' web unknown')
 sustainedLoss = false; loseTitle = null
 await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
 await expect(page.locator('.te-footer [role=alert]')).toHaveCount(0)
 await expect.poll(() => requests.filter(row => row.title === prefix + ' web unknown').at(-1)?.replayed).toBe(true)
 await expect(page.locator('.te-spinner')).toHaveCount(0)
 const webRetries = requests.filter(row => row.title === prefix + ' web unknown')
 expect(webRetries.length).toBeGreaterThanOrEqual(2); expect(webRetries[0].key).toBeTruthy(); expect(webRetries.every(row => row.key === webRetries[0].key)).toBe(true); expect(webRetries.at(-1).replayed).toBe(true)
 await page.locator('.te-footer .te-cancel').click()
 mark('compiled web lost committed response remains explicit and retries with the same key without a second mutation')
 const sibling = await context.newPage(); sibling.on('pageerror', error => errors.push(error.message))
 await sibling.goto(address(web) + '/projects'); await expect(sibling.locator('.gantt-bar').filter({ hasText: prefix }).first()).toBeVisible()
 expect(await page.evaluate(() => window.idbTouches)).toBe(0); expect(await sibling.evaluate(() => window.idbTouches)).toBe(0)
 mark('compiled web uses HTTP with no IndexedDB or injected desktop bridge; two tabs and confirmed edits work')
 await browser.close(); browser = null
 let { page: desktop, origin } = await launchNative()
 await login(desktop, origin, false)
 expect(await desktop.evaluate(() => window.erpDesktop.appVersion())).toMatchObject({ version: readVersion() })
 await queue(desktop, 'configure', { autoSync: false })
 await queue(desktop, 'sync', { force: true, pullOnly: true })
 await desktop.reload()
 await expect(desktop.locator('.gantt-bar').filter({ hasText: prefix }).first()).toBeVisible({ timeout: 20000 })
 offline = true
 await edit(desktop, prefix + ' offline persisted')
 await expect.poll(async () => (await queueRows(desktop)).length).toBe(1)
 const operation = (await queueRows(desktop))[0]
 expect(operation.input.body.title).toBe(prefix + ' offline persisted'); expect(operation.operationId).toBeTruthy()
 await desktop.locator('.te-footer .te-cancel').click()
 await native.evaluate(() => { globalThis.artifactFixture.createWindow(globalThis.artifactFixture.origin + '/planner') })
 await expect.poll(() => native.windows().length).toBe(2)
 const peer = native.windows().find(page => page !== desktop)
 await expect(peer.locator('.gantt-bar').filter({ hasText: prefix + ' offline persisted' }).first()).toBeVisible({ timeout: 20000 })
 expect((await queueRows(peer))[0].operationId).toBe(operation.operationId)
 mark('two packaged windows share the same persisted offline operation')
 const window = await native.browserWindow(desktop)
 await window.evaluate(win => new Promise(resolve => {
  win.webContents.once('did-finish-load', resolve)
  win.webContents.forcefullyCrashRenderer()
 }))
 // Playwright keeps a crashed page detached; the recovered native document remains observable from main.
 await expect.poll(() => window.evaluate((win, title) => win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.gantt-bar')).some(bar => bar.textContent.includes(${JSON.stringify(title)}))`), prefix + ' offline persisted'), { timeout: 20000 }).toBe(true)
 expect(await window.evaluate(win => win.webContents.executeJavaScript("window.erpDesktop.session.status().then(state => window.erpDesktop.queue.request({action:'list',contextId:state.contextId})).then(rows => rows[0].operationId)"))).toBe(operation.operationId)
 mark('packaged renderer crash recovery preserves the committed intent and its projection')
 const child = native.process(), exited = new Promise(resolve => child.once('exit', resolve))
 child.kill('SIGKILL'); await exited; native = null
 ;({ page: desktop, origin } = await launchNative())
 if (new URL(desktop.url()).pathname === '/login') {
  await desktop.locator('input[autocomplete=username]').fill('admin')
  await desktop.locator('.lp-offline-btn').click()
 }
 await expect(desktop).not.toHaveURL(/\/login/)
 await expect(desktop.locator('.gantt-bar').filter({ hasText: prefix + ' offline persisted' }).first()).toBeVisible({ timeout: 20000 })
 const restored = (await queueRows(desktop))[0]
 expect({ operationId: restored.operationId, input: restored.input }).toEqual({ operationId: operation.operationId, input: operation.input })
 mark('actual main and compiled desktop UI in test ASAR preserve the exact offline operation after main is killed and restarted')
 offline = false
 await desktop.evaluate(() => window.erpDesktop.session.refresh())
 await queue(desktop, 'retry', { operationId: operation.operationId }); await queue(desktop, 'push')
 await expect.poll(async () => (await queueRows(desktop)).length).toBe(0)
 expect((await direct('GET', '/task/' + task.id)).title).toBe(prefix + ' offline persisted')
 const mutations = requests.filter(row => row.path === '/api/v1/task/' + task.id && row.method === 'PUT' && row.operation === operation.operationId)
 expect(mutations).toHaveLength(1)
 mark('packaged desktop reconnect delivers the durable operation once with its original identity')
 await queue(desktop, 'sync', { force: true, pullOnly: true })
 await desktop.reload(); await expect(desktop.locator('.gantt-bar').filter({ hasText: prefix }).first()).toBeVisible()
 sustainedLoss = true; loseTitle = prefix + ' lost response'
 await edit(desktop, loseTitle)
 await expect.poll(async () => (await direct('GET', '/task/' + task.id)).title).toBe(prefix + ' lost response')
 await expect.poll(async () => (await queueRows(desktop)).length).toBe(1)
 const unknown = (await queueRows(desktop))[0]
 const attempted = requests.filter(row => row.method === 'PUT' && row.operation === unknown.operationId).length
 sustainedLoss = false; loseTitle = null
 await queue(desktop, 'retry', { operationId: unknown.operationId }); await queue(desktop, 'push')
 await expect.poll(async () => (await queueRows(desktop)).length).toBe(0)
 const recovered = requests.filter(row => row.path === '/api/v1/task/' + task.id && row.method === 'PUT' && row.operation === unknown.operationId)
 expect(recovered).toHaveLength(attempted); expect(recovered.filter(row => row.replayed === false)).toHaveLength(1)
 mark('packaged lost response after backend commit resolves by receipt without a second mutation')
 expect(errors).toEqual([])
 expect(manifests[0].target).toBe('web')
 console.log(JSON.stringify({ cases: report.length, report }))
} catch (error) {
 console.error(error)
 if (native) console.error('Artifact UI diagnostics', await native.windows()[0]?.evaluate(async () => ({
  url: location.pathname, editor: document.querySelector('.te-footer')?.textContent,
  sessionMode: (await window.erpDesktop.session.status()).mode,
  service: (await window.erpDesktop.service.status()).queue,
 })).catch(() => null), requests.filter(row => row.title))
 throw error
} finally {
 offline = false
 if (native) await native.close()
 if (browser) await browser.close()
 if (project) await direct('DELETE', '/project/' + project.id)
 await close(web); await close(proxy)
 rmSync(profile, { recursive: true, force: true })
}
