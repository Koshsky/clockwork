import { _electron, expect } from 'playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

if (!process.env.ELECTRON_EXECUTABLE) throw new Error('Set ELECTRON_EXECUTABLE for native IPC tests')
const root = await mkdtemp(path.join(tmpdir(), 'clockwork-ipc-')), profile = path.join(root, 'profile'), web = path.join(root, 'web')
await mkdir(web); await writeFile(path.join(web, 'index.html'), '<!doctype html><meta charset="utf-8"><title>IPC fixture</title><main>Service fixture</main>')
const env = { ...process.env, ERP_SERVICE_TEST_PROFILE: profile, ERP_SERVICE_TEST_WEB: web }; delete env.ELECTRON_RUN_AS_NODE
const main = fileURLToPath(new URL('./desktop-service-main.cjs', import.meta.url))
let app, restarted
const failures = [], report = []
async function launch(extra = {}) { return _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE, args: [main], env: { ...env, ...extra } }) }
async function ready(page) { await page.waitForURL(/http:\/\/127\.0\.0\.1:/); await page.waitForFunction(() => !!window.erpDesktop?.service); return page.evaluate(() => window.erpDesktop.service.status()) }
async function request(page, id, title = 'Saved') {
  return page.evaluate(async ({ id, title }) => {
    const bridge = window.erpDesktop.service, state = await bridge.status()
    return bridge.execute({ requestId: 'request-' + id, operationId: id, contextId: state.context.id, operation: 'task.update', input: { id: 1, patch: { title } } })
  }, { id, title })
}
try {
  app = await launch()
  app.context().on('page', page => page.on('pageerror', error => failures.push(error.message)))
  const first = await app.firstWindow(), initial = await ready(first)
  const secondWindow = app.waitForEvent('window')
  await app.evaluate(() => { serviceFixture.createWindow() })
  const second = await secondWindow; await ready(second)
  expect(await second.evaluate(() => window.erpDesktop.service.status())).toMatchObject({ profileId: initial.profileId, instanceId: initial.instanceId, phase: 'ready' })
  expect(await first.evaluate(() => ({ require: typeof window.require, process: typeof window.process, ipc: 'ipcRenderer' in window.erpDesktop }))).toEqual({ require: 'undefined', process: 'undefined', ipc: false })
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => win.webContents.getLastWebPreferences()))
  for (const prefs of preferences) { expect(prefs.contextIsolation).toBe(true); expect(prefs.sandbox).toBe(true); expect(prefs.nodeIntegration).toBe(false) }
  report.push('PASS native windows share one service/profile; sandbox and context isolation stay enabled without Node exposure')

  for (const page of [first, second]) await page.evaluate(() => { window.states = []; window.unsubscribe = window.erpDesktop.service.subscribe(state => window.states.push(state)) })
  await expect.poll(() => first.evaluate(() => window.states.length)).toBeGreaterThan(0)
  await expect.poll(() => second.evaluate(() => window.states.length)).toBeGreaterThan(0)
  expect((await request(first, 'normal')).status).toBe('confirmed')
  await expect.poll(() => first.evaluate(() => window.states.at(-1)?.running)).toBe(0)
  await expect.poll(() => second.evaluate(() => window.states.at(-1)?.revision)).toBe(await first.evaluate(() => window.states.at(-1).revision))
  report.push('PASS both windows receive consistent bounded status events')

  const malformed = await first.evaluate(async () => {
    const bridge = window.erpDesktop.service, state = await bridge.status()
    const base = { requestId: 'bad', contextId: state.context.id, source: 'refresh' }
    return Promise.all([
      bridge.read({ ...base, operation: 'sql', input: { sql: 'SELECT * FROM users' } }),
      bridge.read({ ...base, operation: 'planning.tasks', input: undefined, accountId: 999 }),
      bridge.execute({ requestId: 'bad', contextId: state.context.id, operationId: 'bad', operation: 'task.update', input: { id: 1, patch: { title: 'x'.repeat(65537) } } }),
      bridge.execute({ requestId: 'bad', contextId: 'another-account', operationId: 'bad', operation: 'task.update', input: { id: 1, patch: {} } }),
    ])
  })
  expect(malformed.map(result => result.status)).toEqual(['failed', 'failed', 'rejected', 'rejected'])
  expect(await app.evaluate(() => serviceFixture.calls())).toEqual({ normal: 1 })
  report.push('PASS unknown operations, account spoofing, oversized DTOs and wrong contexts never reach an adapter')

  await first.evaluate(async () => {
    const bridge = window.erpDesktop.service, state = await bridge.status()
    window.readResult = bridge.read({ requestId: 'cancel-me', contextId: state.context.id, operation: 'resource.list', input: {}, source: 'refresh' })
  })
  expect(await second.evaluate(() => window.erpDesktop.service.cancel('cancel-me'))).toBe(false)
  expect(await first.evaluate(() => window.erpDesktop.service.cancel('cancel-me'))).toBe(true)
  expect((await first.evaluate(() => window.readResult)).status).toBe('cancelled')
  report.push('PASS read cancellation is scoped to the requesting document')

  await first.evaluate(async () => {
    const bridge = window.erpDesktop.service, state = await bridge.status()
    window.pending = bridge.execute({ requestId: 'held-close', operationId: 'held-close', contextId: state.context.id, operation: 'task.update', input: { id: 1, patch: { title: 'hold' } } })
    void window.pending.catch(() => {})
  })
  await expect.poll(() => app.evaluate(() => serviceFixture.calls()['held-close'])).toBe(1)
  await first.close(); await app.evaluate(() => serviceFixture.release('held-close'))
  expect((await request(second, 'held-close', 'hold')).status).toBe('confirmed')
  expect(await app.evaluate(() => serviceFixture.calls()['held-close'])).toBe(1)
  expect((await request(second, 'held-close', 'Different'))).toMatchObject({ status: 'conflict' })
  report.push('PASS closing the originating window preserves an accepted command and its same-key receipt, without a second execution')

  const crashWindow = app.waitForEvent('window')
  await app.evaluate(() => { serviceFixture.createWindow() })
  const crashing = await crashWindow; await ready(crashing)
  await crashing.evaluate(async () => {
    const bridge = window.erpDesktop.service, state = await bridge.status()
    void bridge.execute({ requestId: 'held-crash', operationId: 'held-crash', contextId: state.context.id, operation: 'task.update', input: { id: 1, patch: { title: 'hold' } } }).catch(() => {})
  })
  await expect.poll(() => app.evaluate(() => serviceFixture.calls()['held-crash'])).toBe(1)
  const crashWindowHandle = await app.browserWindow(crashing)
  const crashId = await crashWindowHandle.evaluate(win => win.webContents.id)
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).forcefullyCrashRenderer(), crashId)
  await expect.poll(() => app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)
    return !contents.isCrashed() && contents.executeJavaScript('window.erpDesktop.service.status()').catch(() => null)
  }, crashId).catch(() => null), { timeout: 15000 }).toMatchObject({ instanceId: initial.instanceId, phase: 'ready' })
  await app.evaluate(() => serviceFixture.release('held-crash'))
  expect((await request(second, 'held-crash', 'hold')).status).toBe('confirmed')
  expect(await app.evaluate(() => serviceFixture.calls()['held-crash'])).toBe(1)
  report.push('PASS renderer crash leaves the service and surviving window operational')

  const outsideWindow = app.waitForEvent('window')
  const outsider = await app.evaluate(({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    void win.loadURL(serviceFixture.origin)
    return win.webContents.id
  }, fileURLToPath(new URL('../desktop/preload.js', import.meta.url)))
  const outside = await outsideWindow
  await outside.waitForFunction(() => !!window.erpDesktop?.service)
  expect(await outside.evaluate(() => window.erpDesktop.service.status().then(() => 'allowed', error => error.message))).toContain('DESKTOP_UNTRUSTED_SENDER')
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).close(), outsider)
  report.push('PASS an unregistered native window cannot read profile metadata or invoke privileged IPC')

  const child = spawn(process.env.ELECTRON_EXECUTABLE, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const exited = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Second instance did not exit')) }, 15000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  expect(exited).toBe(0); expect(output).not.toContain('DESKTOP_SERVICE_READY')
  await expect.poll(() => app.evaluate(() => serviceFixture.secondInstances())).toBeGreaterThan(0)
  report.push('PASS a real second application process exits before service startup and focuses the first instance')

  const origin = await app.evaluate(() => serviceFixture.origin)
  await app.close(); app = null
  restarted = await launch(); const after = await ready(await restarted.firstWindow())
  expect(after.profileId).toBe(initial.profileId); expect(after.instanceId).not.toBe(initial.instanceId)
  expect(await restarted.evaluate(() => serviceFixture.origin)).not.toBe(origin)
  report.push('PASS profile identity survives restart on another local port')
  expect(failures).toEqual([])
  console.log(report.join('\n'))
} catch (error) {
  if (app) console.log('IPC diagnostics:', await app.evaluate(({ BrowserWindow }) => ({ events: serviceFixture?.diagnostics, phase: serviceFixture?.service.status().phase, windows: BrowserWindow.getAllWindows().map(win => ({ id: win.webContents.id, crashed: win.webContents.isCrashed(), url: win.webContents.getURL() })) })).catch(() => null))
  throw error
} finally {
  try { if (app) await app.close(); if (restarted) await restarted.close() }
  finally { await rm(root, { recursive: true, force: true }) }
}
