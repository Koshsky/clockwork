import { chromium, expect } from 'playwright/test'
import fs from 'node:fs'
import { launchElectronFixture } from './helpers/electron.mjs'

const base = process.env.ERP_TEST_URL || 'http://127.0.0.1:5173'
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local backend tests only')
const envPath = process.env.ERP_TEST_ENV || new URL('../../local/dev.env', import.meta.url)
const env = process.env.ERP_TEST_PASSWORD ? {} : Object.fromEntries(fs.readFileSync(envPath, 'utf8').split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]
}))
const password = process.env.ERP_TEST_PASSWORD || env.ADMIN_PASSWORD
if (!password) throw new Error('Set ERP_TEST_PASSWORD or ERP_TEST_ENV')
const native = process.env.ERP_TEST_DESKTOP === '1' && process.env.ELECTRON_EXECUTABLE ? await launchElectronFixture() : null
const browser = native ? null : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const context = native ? native.app.context() : await browser.newContext()
await context.addInitScript(() => localStorage.setItem('mvs_erp_auto_sync', '0'))
const cspViolations = []
if (process.env.ERP_TEST_CSP === '1') {
  await context.exposeBinding('reportCspViolation', (_, value) => cspViolations.push(value))
  await context.addInitScript(() => document.addEventListener('securitypolicyviolation', event => {
    void window.reportCspViolation({ directive: event.effectiveDirective, blocked: event.blockedURI })
  }))
}
if (process.env.ERP_TEST_DESKTOP === '1') {
  await context.addInitScript(() => { if (!window.erpDesktop) window.erpDesktop = { isElectron: true, appVersion: async () => ({ version: '1.6.1', electron: 'csp-test' }) } })
}
const page = native ? await native.app.firstWindow() : await context.newPage()
page.setDefaultTimeout(20_000)
let fault = null
let lost = null
let held = false
let heldKey = null
let releaseHold = () => {}
const replays = []
const created = { project: null, resource: null }
const prefix = `Offline-P0-${Date.now()}`
const report = []

async function runtime() {
  await page.evaluate(async (axiosPath) => {
    const store = await import('/src/store/index.ts')
    const token = await import('/src/token.ts')
    const outbox = await import('/src/offline/outbox.ts')
    const db = await import('/src/offline/db.ts')
    const cache = await import('/src/offline/cache.ts')
    const state = await import('/src/offline/state.ts')
    const sync = await import('/src/offline/sync.ts')
    const settings = await import('/src/settings.ts')
    const { default: axios } = await import(axiosPath)
    settings.autoSync.value = false
    window.p0 = { planning: store.usePlanningStore(), app: store.useAppStore(), auth: store.useAuthStore(), outbox, db, cache, state, sync, axios, token }
  }, process.env.ERP_TEST_AXIOS_PATH || '/node_modules/.vite/deps/axios.js')
}
async function api(method, path, data) {
  return page.evaluate(async ({ method, path, data }) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await window.p0.axios({ method, url: '/api/v1' + path, data, headers: { Authorization: 'Bearer ' + window.p0.token.getAccessToken() }, validateStatus: (status) => status === 429 || status >= 200 && status < 300 })
      // Fixture and verification reads must respect the real server's rate limit.
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(response.headers['retry-after']) || 1) * 1000))
        continue
      }
      if (response.data?.error?.code != null) throw new Error(response.data.error.message)
      return response.data?.data
    }
    throw new Error('Fixture request remained rate limited after five attempts')
  }, { method, path, data })
}
async function queue() { return page.evaluate(() => window.p0.db.idbAll('outbox').then((rows) => rows.sort((a, b) => a.ts - b.ts))) }
async function reset() {
  fault = null
  await page.evaluate(async () => {
    window.p0.state.isOffline.value = false
    await window.p0.outbox.clearOutbox()
    await window.p0.planning.refreshTaskPlanning(true)
  })
}
async function offline() {
  fault = { type: 'offline' }
  await page.evaluate(() => { window.p0.state.isOffline.value = true })
}
async function recover() {
  fault = null
  // Let the shared local API rate-limit bucket refill before the recovery burst.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  return page.evaluate(async () => {
    window.p0.state.isOffline.value = false
    await window.p0.sync.syncNow()
    return window.p0.sync.syncNotice.value
  })
}
async function tasks() {
  const data = await api('get', '/planning/tasks')
  return (data.processes || []).flatMap((p) => p.tasks || []).filter((t) => t.title?.startsWith(prefix))
}
async function createOffline(title, fixture) {
  const ok = await page.evaluate(async ({ title, fixture }) => {
    return window.p0.planning.createTask({ title, process_id: fixture.process, start_date: '2026-11-09', end_date: '2026-11-22' })
  }, { title, fixture })
  expect(ok).toBe(true)
  const entries = await queue()
  const entry = entries.find((e) => e.method.toLowerCase() === 'post' && e.body?.title === title)
  expect(entry?.tempId).toBeLessThan(0)
  return entry.tempId
}
async function edit(id, title) {
  return page.evaluate(({ id, title }) => window.p0.planning.updateTaskMeta(id, { title }), { id, title })
}
async function cachedTask(title) {
  return page.evaluate(async (title) => {
    const body = await window.p0.cache.cacheGetByPath('/api/v1/planning/tasks')
    return body?.data?.processes?.flatMap((p) => p.tasks || []).find((t) => t.title === title)
  }, title)
}
async function settled(title, resourceId, quantity) {
  const rows = await page.evaluate((title) => window.p0.planning.taskPlanning?.processes?.flatMap((p) => p.tasks || []).filter((t) => t.title === title), title)
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBeGreaterThan(0)
  const cached = await cachedTask(title)
  expect(cached?.id).toBe(rows[0].id)
  if (resourceId) {
    expect(rows[0].resources.filter((r) => r.id === resourceId)).toHaveLength(1)
    expect(rows[0].resources.find((r) => r.id === resourceId).quantity).toBe(quantity)
    expect(cached.resources.find((r) => r.id === resourceId).quantity).toBe(quantity)
  }
}

async function reload() {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page).not.toHaveURL(/\/login/)
  await runtime()
  await page.evaluate(() => window.p0.planning.loadTaskPlanning())
}

await page.route('**/api/v1/**', async (route) => {
  const req = route.request()
  const url = new URL(req.url())
  const path = url.pathname
  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) && !path.includes('/auth/')
  const f = fault
  if (f?.type === 'offline-all') return route.abort('failed')
  if (f?.type === 'offline' && !path.includes('/auth/')) return route.abort('failed')
  if (f?.type === 'interrupt' && f.sends >= 2 && path.endsWith('/health')) return route.abort('failed')
  if (!mutation) return route.continue()
  if (f?.type === 'interrupt' && req.method() === 'PUT') {
    f.sends++
    if (f.sends === 2) return route.abort('failed')
  }
  const response = await route.fetch({ maxRetries: 0 })
  if (response.headers()['idempotency-replayed'] === 'true') replays.push({ path, key: req.headers()['idempotency-key'] })
  if (f?.type === 'lose' && !f.hit && path === '/api/v1/task' && req.method() === 'POST') {
    f.hit = true
    expect(response.status()).toBe(201)
    lost = { body: await response.json(), key: req.headers()['idempotency-key'] }
    return route.abort('failed')
  }
  if (f?.type === 'hold' && !f.hit && /\/task\/\d+$/.test(path) && req.method() === 'PUT') {
    f.hit = true
    expect(response.status()).toBe(200)
    heldKey = req.headers()['idempotency-key']
    held = true
    await new Promise((resolve) => { releaseHold = resolve })
    await route.abort('failed').catch(() => {})
    return
  }
  await route.fulfill({ response })
})

try {
  await page.goto(base + '/login')
  await page.locator('input[autocomplete=username]').fill('admin')
  await page.locator('input[autocomplete=current-password]').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await runtime()
  const userId = await page.evaluate(() => window.p0.auth.user.id)
  const project = await api('post', '/project', { title: prefix, code: 'P0-' + Date.now(), owner_id: userId, start_date: '2026-11-01', end_date: '2026-12-31' })
  created.project = project.id
  const processRow = await api('post', '/process', { title: prefix, project_id: project.id, owner_id: userId, start_date: '2026-11-01', end_date: '2026-12-31' })
  const resource = await api('post', '/resources', { title: prefix, code: 'P0-' + Date.now(), owner_id: userId })
  created.resource = resource.id
  const fixture = { process: processRow.id, resource: resource.id }
  await page.goto(base + '/planner')
  await runtime()
  await page.evaluate(async () => { await window.p0.app.refreshResources(); await window.p0.planning.refreshTaskPlanning(true) })

  // P0-1: the failed mutation and its optimistic cache survive a document reload.
  await offline()
  const name1 = prefix + '-network-loss'
  await createOffline(name1, fixture)
  expect((await queue()).length).toBe(1)
  expect(await cachedTask(name1)).toBeTruthy()
  await reload()
  expect((await queue()).length).toBe(1)
  expect(await cachedTask(name1)).toBeTruthy()
  await recover()
  expect((await tasks()).filter((t) => t.title === name1)).toHaveLength(1)
  expect(await queue()).toHaveLength(0)
  await settled(name1)
  report.push('P0-1 PASS: API loss, persistent queue/cache, reload and recovery')

  // P0-2: route.fetch receives a committed server result, but the browser loses it.
  await reset()
  fault = { type: 'lose', hit: false }
  const name2 = prefix + '-lost-committed-response'
  const temp2 = await createOffline(name2, fixture)
  expect(lost?.key).toBeTruthy()
  const pending2 = (await queue()).find((e) => e.tempId === temp2)
  expect(pending2.idempotencyKey).toBe(lost.key)
  fault = null
  expect((await tasks()).filter((t) => t.title === name2)).toHaveLength(1)
  await recover()
  expect((await tasks()).filter((t) => t.title === name2)).toHaveLength(1)
  expect(replays.some((r) => r.key === lost.key)).toBe(true)
  expect(await queue()).toHaveLength(0)
  await settled(name2)
  report.push('P0-2 PASS: actual backend commit, lost response, same-key replay, one row')

  // P0-3: a second outage retains exactly the unacknowledged suffix.
  await reset()
  const rows = (await tasks()).slice(0, 2)
  await offline()
  await edit(rows[0].id, prefix + '-suffix-first')
  await edit(rows[1].id, prefix + '-suffix-second')
  const originalQueue = await queue()
  expect(originalQueue).toHaveLength(2)
  fault = { type: 'interrupt', sends: 0 }
  await page.evaluate(() => { window.p0.state.isOffline.value = false })
  const interrupted = await page.evaluate(() => window.p0.outbox.flushOutbox())
  expect(interrupted.ok).toBe(1)
  expect(interrupted.interrupted).toBe(true)
  const remaining = await queue()
  expect(remaining).toHaveLength(1)
  expect(remaining[0].id).toBe(originalQueue[1].id)
  await reload()
  await recover()
  expect(await queue()).toHaveLength(0)
  const after3 = await tasks()
  expect(after3.some((t) => t.title === prefix + '-suffix-first')).toBe(true)
  expect(after3.some((t) => t.title === prefix + '-suffix-second')).toBe(true)
  await settled(prefix + '-suffix-second')
  report.push('P0-3 PASS: interrupted flush retains only unsent suffix across reload')

  // P0-4: creator, edit and assignment are ordered and use the returned real id.
  await reset()
  await offline()
  const name4 = prefix + '-dependent-create'
  const temp4 = await createOffline(name4, fixture)
  expect(await edit(temp4, prefix + '-dependent-edited')).toBe(true)
  expect(await page.evaluate(({ id, resource }) => window.p0.planning.assignResource(id, resource, 2), { id: temp4, resource: fixture.resource })).toBe(true)
  expect(await queue()).toHaveLength(3)
  await recover()
  const task4 = (await tasks()).find((t) => t.title === prefix + '-dependent-edited')
  expect(task4?.id).toBeGreaterThan(0)
  expect(task4.resources.filter((r) => r.id === fixture.resource)).toHaveLength(1)
  expect(task4.resources.find((r) => r.id === fixture.resource).quantity).toBe(2)
  expect(await queue()).toHaveLength(0)
  await settled(prefix + '-dependent-edited', fixture.resource, 2)
  report.push('P0-4 PASS: create/edit/assign dependencies resolve to real ids')

  // P0-5: a permanent rejection is quarantined once without blocking independent work.
  await reset()
  await expect.poll(() => page.evaluate(async () => {
    const response = await window.p0.axios.get('/api/v1/task/2147480000', {
      headers: { Authorization: 'Bearer ' + window.p0.token.getAccessToken() },
      validateStatus: () => true,
    })
    return response.status
  }), { timeout: 10_000, intervals: [1000] }).toBe(404)
  await page.evaluate(async ({ id, title }) => {
    await window.p0.outbox.enqueueMutation({ entity: 'task', method: 'PUT', url: '/api/v1/task/2147480000', body: { title: 'Missing task' } })
    await window.p0.outbox.enqueueMutation({ entity: 'task', method: 'PUT', url: '/api/v1/task/' + id, body: { title } })
  }, { id: task4.id, title: prefix + '-independent-success' })
  const notice = await recover()
  expect(notice.ok).toBe(1)
  expect(notice.failed).toBe(1)
  const rejected = await queue()
  expect(rejected).toHaveLength(1)
  expect(rejected[0].quarantined).toBe(true)
  expect(rejected[0].failed.message).toBeTruthy()
  await recover()
  expect((await queue())[0].attempts).toBe(rejected[0].attempts)
  expect((await tasks()).some((t) => t.title === prefix + '-independent-success')).toBe(true)
  report.push('P0-5 PASS: rejected entry quarantined with reason; independent edit succeeds')

  // P0-6: reload after a creator is acknowledged but a dependent response is lost.
  await reset()
  await offline()
  const temp6 = await createOffline(prefix + '-reload-created', fixture)
  await edit(temp6, prefix + '-reload-edited')
  await page.evaluate(({ id, resource }) => window.p0.planning.assignResource(id, resource, 3), { id: temp6, resource: fixture.resource })
  fault = { type: 'hold', hit: false }
  held = false
  await page.evaluate(() => { window.p0.state.isOffline.value = false; void window.p0.outbox.flushOutbox() })
  await expect.poll(() => held).toBe(true)
  expect(await queue()).toHaveLength(2)
  const map = await page.evaluate(() => window.p0.db.idbAll('idmap'))
  expect(map.some((m) => m.temp === temp6 && m.real > 0)).toBe(true)
  await reload()
  releaseHold()
  expect(await queue()).toHaveLength(2)
  expect((await queue()).some((entry) => entry.idempotencyKey === heldKey)).toBe(true)
  expect(await page.evaluate(() => window.p0.db.idbAll('idmap'))).toEqual(map)
  await recover()
  const task6 = (await tasks()).filter((t) => t.title === prefix + '-reload-edited')
  expect(task6).toHaveLength(1)
  expect(task6[0].resources.filter((r) => r.id === fixture.resource)).toHaveLength(1)
  expect(task6[0].resources.find((r) => r.id === fixture.resource).quantity).toBe(3)
  expect(await queue()).toHaveLength(0)
  expect(replays.some((r) => r.key === heldKey)).toBe(true)
  await settled(prefix + '-reload-edited', fixture.resource, 3)
  // Sibling tabs can still enqueue edits against these completed temporary ids.
  const finalMaps = await page.evaluate(() => window.p0.db.idbAll('idmap'))
  expect(finalMaps).toEqual(expect.arrayContaining(map))
  expect(finalMaps.every(item => item.temp < 0 && item.real > 0)).toBe(true)
  expect(new Set(finalMaps.map(item => item.temp)).size).toBe(finalMaps.length)
  report.push('P0-6 PASS: reload mid-flush preserves suffix, keys and persistent id map')

  // Explicit Push must restore authorization after an offline cold document start.
  await reset()
  await offline()
  const manualTitle = prefix + '-manual-recovery'
  await createOffline(manualTitle, fixture)
  fault = { type: 'offline-all' }
  await reload()
  expect(await queue()).toHaveLength(1)
  expect(await cachedTask(manualTitle)).toBeTruthy()
  fault = null
  await page.evaluate(() => window.p0.sync.syncNow())
  expect(await queue()).toHaveLength(0)
  expect((await tasks()).filter(task => task.title === manualTitle)).toHaveLength(1)
  report.push('P0-7 PASS: one manual Push restores auth and delivers the offline queue with auto-sync disabled')
  expect(cspViolations, 'offline queue/cache/recovery must not violate CSP').toEqual([])
  console.log(report.join('\n'))
} finally {
  fault = null
  releaseHold()
  try {
    await runtime()
    await page.evaluate(async () => { window.p0.state.isOffline.value = false; await window.p0.outbox.clearOutbox() })
    if (created.project) await api('delete', '/project/' + created.project)
    if (created.resource) await api('delete', '/resources/' + created.resource)
  } catch (error) { console.error('Fixture cleanup failed:', error.message) }
  if (native) await native.close(); else await browser.close()
}
