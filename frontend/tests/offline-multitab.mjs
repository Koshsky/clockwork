import { chromium, expect, request } from 'playwright/test'
import { createHmac } from 'node:crypto'

const web = process.env.ERP_TEST_URL ?? 'http://localhost:5173'
const apiURL = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
for (const value of [web, apiURL]) if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) throw new Error('Multi-tab fixtures require loopback URLs')
if (!process.env.RBAC_TEST_ADMIN_PASSWORD || !process.env.JWT_SECRET_KEY) throw new Error('Set local RBAC_TEST_ADMIN_PASSWORD and JWT_SECRET_KEY')
const http = await request.newContext({ baseURL: `${apiURL}/` })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(origin => {
  if (location.origin === origin) localStorage.setItem('mvs_erp_auto_sync', '0')
}, new URL(web).origin)
let admin, userId, projectId, processId, userPassword
let apiOffline = false, lostTitle = null, lostReply = false
let refreshes = 0, transitions = 0
let delayRefresh = false, refreshHeld = false, releaseRefresh = () => {}
const prefix = `mt${Date.now()}`
const errors = [], sends = [], report = []
context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
context.on('request', req => { if (new URL(req.url()).pathname.endsWith('/auth/refresh')) refreshes++ })
async function call(token, method, path, data) {
  for (let n = 0; n < 10; n++) {
    const response = await http.fetch(path, { method, data, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (response.status() === 429) { await new Promise(r => setTimeout(r, 1000)); continue }
    const text = await response.text()
    return { status: response.status(), ...(text ? JSON.parse(text) : {}) }
  }
  throw new Error('Fixture rate limit did not recover')
}
async function fixture(path, data) {
  const reply = await call(admin, 'POST', path, data)
  expect(reply.status, `fixture ${path}`).toBe(201)
  return reply.data
}
async function runtime(page) {
  await page.evaluate(async () => {
    const store = await import('/src/store/index.ts')
    window.mt = {
      auth: store.useAuthStore(), planning: store.usePlanningStore(), rbac: store.useRbacStore(),
      token: await import('/src/token.ts'), outbox: await import('/src/offline/outbox.ts'),
      db: await import('/src/offline/db.ts'), state: await import('/src/offline/state.ts'),
      connection: await import('/src/offline/connection.ts'), sync: await import('/src/offline/sync.ts'),
      settings: await import('/src/settings.ts'),
    }
    await window.mt.rbac.loadMyPermissions()
  })
}
async function navigate(page, path) {
  const nav = page.locator('.nd')
  if (!/nd--open/.test(await nav.getAttribute('class'))) await page.locator('.ah-burger').click()
  const link = nav.locator(`a[href="${path}"]`)
  if (!await link.isVisible()) await link.locator('xpath=ancestor::section').locator('.nd-group-head').click()
  await link.click()
  await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 1500 })
  transitions++
}
async function expire(page) {
  const current = await page.evaluate(() => window.mt.token.getAccessToken())
  const [head, body] = current.split('.')
  const header = JSON.parse(Buffer.from(head, 'base64url'))
  if (header.alg !== 'HS256') throw new Error('Unexpected local JWT algorithm')
  const claims = JSON.parse(Buffer.from(body, 'base64url'))
  claims.exp = Math.floor(Date.now() / 1000) - 60
  const unsigned = `${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const token = `${unsigned}.${createHmac('sha256', process.env.JWT_SECRET_KEY).update(unsigned).digest('base64url')}`
  await page.evaluate(token => window.mt.token.setAccessToken(token), token)
}
async function queue(page) { return page.evaluate(() => window.mt.db.idbAll('outbox').then(rows => rows.sort((a, b) => a.ts - b.ts))) }
async function setOffline(page, value) { await page.evaluate(value => { window.mt.state.isOffline.value = value }, value) }
async function createOffline(page, title, frozen) {
  const ok = await page.evaluate(async ({ title, processId, frozen }) => {
    const now = Date.now
    if (frozen != null) Date.now = () => frozen
    try { return await window.mt.planning.createTask({ title, process_id: processId, start_date: '2026-11-09', end_date: '2026-11-22' }) }
    finally { Date.now = now }
  }, { title, processId, frozen })
  expect(ok).toBe(true)
  return (await queue(page)).find(row => row.body?.title === title)
}
async function tasks() {
  const reply = await call(admin, 'GET', 'planning/tasks')
  expect(reply.status).toBe(200)
  return reply.data.processes.flatMap(row => row.tasks ?? []).filter(row => row.title?.startsWith(prefix))
}
await context.route('**/api/v1/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname
  if (apiOffline) return route.abort('failed')
  if (delayRefresh && path.endsWith('/auth/refresh')) {
    refreshHeld = true
    await new Promise(resolve => { releaseRefresh = resolve })
  }
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method()) || path.includes('/auth/')) return route.continue()
  const body = req.postDataJSON()
  const response = await route.fetch({ maxRetries: 0 })
  sends.push({ path, method: req.method(), title: body?.title, key: req.headers()['idempotency-key'], status: response.status(), replay: response.headers()['idempotency-replayed'] === 'true' })
  if (!lostReply && body?.title === lostTitle && req.method() === 'POST' && response.status() === 201) {
    lostReply = true
    apiOffline = true
    return route.abort('failed')
  }
  if (apiOffline) return route.abort('failed')
  await route.fulfill({ response })
})
let first, second
try {
  const login = await call(null, 'POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD })
  expect(login.status).toBe(200); admin = login.data.access_token
  const user = await fixture('user', { username: prefix, first_name: 'Offline', last_name: 'MultiTab', preset: 'vp' })
  userId = user.user.id; userPassword = user.password
  const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
  projectId = (await fixture('project', { ...dates, code: prefix, owner_id: userId })).id
  processId = (await fixture('process', { ...dates, title: prefix, project_id: projectId, owner_id: userId })).id
  first = await context.newPage()
  await first.goto(`${web}/login`)
  await first.locator('input[autocomplete=username]').fill(prefix)
  await first.locator('input[autocomplete=current-password]').fill(userPassword)
  await first.locator('button[type=submit]').click()
  await expect(first).not.toHaveURL(/\/login/)
  await runtime(first)
  second = await context.newPage()
  await second.goto(`${web}/projects`)
  await expect(second.locator('.ah-burger')).toBeVisible()
  await runtime(second)
  for (const page of [first, second]) {
    for (const path of ['/projects', '/processes', '/planner', '/resources', '/system/queue']) await navigate(page, path)
    await page.evaluate(() => window.mt.planning.refreshTaskPlanning(true))
  }
  await Promise.all([expire(first), expire(second)])
  const baseline = refreshes
  await Promise.all([navigate(first, '/projects'), navigate(second, '/processes')])
  await expect.poll(() => first.evaluate(() => window.mt.auth.accessExpired())).toBe(false)
  await expect.poll(() => second.evaluate(() => window.mt.auth.accessExpired())).toBe(false)
  expect(refreshes - baseline, 'the two expired tabs share one renewal').toBe(1)
  report.push('PASS simultaneous signed-token expiry: both menus navigate, one shared refresh, no logout')

  apiOffline = true
  await Promise.all([setOffline(first, true), setOffline(second, true)])
  const frozen = Date.now()
  const nameA = `${prefix}-A`, nameB = `${prefix}-B`, editedA = `${prefix}-A-edited`
  const [a, b] = await Promise.all([createOffline(first, nameA, frozen), createOffline(second, nameB, frozen)])
  expect(a.tempId, 'concurrent tabs must never share a temporary entity ID').not.toBe(b.tempId)
  expect(await first.evaluate(({ id, title }) => window.mt.planning.updateTaskMeta(id, { title }), { id: a.tempId, title: editedA })).toBe(true)
  const savedQueue = await queue(first)
  expect(savedQueue).toHaveLength(3)
  const identities = savedQueue.map(({ id, tempId, idempotencyKey }) => ({ id, tempId, idempotencyKey }))
  expect(await queue(second)).toEqual(savedQueue)
  report.push('PASS simultaneous offline creates at the same millisecond: unique IDs, independent edit and shared FIFO queue')

  await Promise.all([expire(first), expire(second)])
  await Promise.all([navigate(first, '/planner'), navigate(second, '/projects')])
  await context.setOffline(true)
  await Promise.all([navigate(first, '/processes'), navigate(second, '/planner')])
  await context.setOffline(false)
  await first.reload()
  await expect(first.locator('.ah-burger')).toBeVisible()
  await runtime(first)
  expect((await queue(first)).map(({ id, tempId, idempotencyKey }) => ({ id, tempId, idempotencyKey }))).toEqual(identities)
  await navigate(first, '/system/queue')
  await expect(first.locator('body')).toContainText(editedA)
  await expect(first.locator('body')).toContainText(nameB)
  expect(await first.evaluate(() => window.mt.auth.isAuthenticated)).toBe(true)
  report.push('PASS expired tokens plus real browser offline navigation and API-offline reload: queue IDs and keys survive')

  apiOffline = false; lostTitle = savedQueue[0].body.title
  await setOffline(first, false)
  await first.evaluate(() => window.mt.sync.syncNow())
  expect(lostReply).toBe(true)
  expect((await tasks()).filter(row => row.title === lostTitle)).toHaveLength(1)
  expect((await queue(first)).map(({ id, tempId, idempotencyKey }) => ({ id, tempId, idempotencyKey }))).toEqual(identities)
  report.push('PASS response lost after backend commit: server has one record, the complete queue remains durable')

  await Promise.all([setOffline(first, true), setOffline(second, true)])
  await second.reload()
  await expect(second.locator('.ah-burger')).toBeVisible()
  await runtime(second)
  expect((await queue(second)).map(({ id, tempId, idempotencyKey }) => ({ id, tempId, idempotencyKey }))).toEqual(identities)
  apiOffline = false; lostTitle = null
  await new Promise(r => setTimeout(r, 1000))
  const recover = page => page.evaluate(async () => {
    window.mt.settings.autoSync.value = true
    await window.mt.connection.retryConnectionNow()
  })
  await Promise.all([recover(first), recover(second)])
  await expect.poll(async () => (await queue(first)).length, { timeout: 20_000 }).toBe(0)
  const rows = await tasks()
  expect(rows.filter(row => row.title === editedA)).toHaveLength(1)
  expect(rows.filter(row => row.title === nameB)).toHaveLength(1)
  expect(rows.some(row => row.title === nameA)).toBe(false)
  expect(sends.some(send => send.replay && send.key === savedQueue[0].idempotencyKey)).toBe(true)
  await Promise.all([navigate(first, '/projects'), navigate(second, '/processes')])
  expect(await first.evaluate(() => window.mt.auth.isAuthenticated)).toBe(true)
  expect(await second.evaluate(() => window.mt.auth.isAuthenticated)).toBe(true)
  expect(await queue(second)).toHaveLength(0)
  report.push('PASS simultaneous automatic reconnect: FIFO edits reach the correct records, lost-response retry is idempotent, queue empty in both tabs')
  await Promise.all([first, second].map(page => page.evaluate(() => { window.mt.settings.autoSync.value = false })))
  await Promise.all([setOffline(first, true), setOffline(second, true)])
  const nameC = `${prefix}-C`
  const c = await createOffline(first, nameC)
  const beforeReauth = await queue(first)
  await Promise.all([expire(first), expire(second)])
  const stored = await first.evaluate(async () => (await import('/src/offline/session.ts')).loadRefreshToken())
  expect((await call(null, 'POST', 'auth/logout', { refresh_token: stored })).status).toBe(200)
  await Promise.all([setOffline(first, false), setOffline(second, false)])
  await navigate(first, '/system/queue')
  await expect(first).toHaveURL(/\/login/)
  await first.evaluate(() => window.mt.sync.syncNow())
  expect(await queue(first)).toEqual(beforeReauth)
  expect(await queue(second)).toEqual(beforeReauth)
  expect((await tasks()).some(row => row.title === nameC)).toBe(false)
  await first.locator('input[autocomplete=username]').fill(prefix)
  await first.locator('input[autocomplete=current-password]').fill(userPassword)
  await first.locator('button[type=submit]').click()
  await expect(first).not.toHaveURL(/\/login/)
  // A sibling that observed logout must restore the newly verified shared session.
  await second.goto(`${web}/processes`)
  await expect(second.locator('.ah-burger')).toBeVisible()
  await runtime(second)
  await expect.poll(() => second.evaluate(() => window.mt.auth.accessExpired())).toBe(false)
  expect((await queue(first))[0]?.idempotencyKey).toBe(c.idempotencyKey)
  await first.evaluate(() => window.mt.sync.syncNow())
  expect(await queue(first)).toHaveLength(0)
  expect((await tasks()).filter(row => row.title === nameC)).toHaveLength(1)
  await Promise.all([navigate(first, '/planner'), navigate(second, '/projects')])
  report.push('PASS backend-revoked refresh: login opens, both tabs retain the unchanged queue, same-user re-login resumes it once')

  await setOffline(first, true)
  const nameD = `${prefix}-D`
  await createOffline(first, nameD)
  const beforeSlow = await queue(first)
  await setOffline(first, false)
  await Promise.all([expire(first), expire(second)])
  delayRefresh = true
  const owner = first.evaluate(() => window.mt.auth.refreshSession())
  await expect.poll(() => refreshHeld).toBe(true)
  const sibling = second.evaluate(async () => {
    window.refreshSettled = false
    const ok = await window.mt.auth.refreshSession()
    window.refreshSettled = true
    return ok
  })
  const pendingSync = second.evaluate(() => window.mt.sync.syncNow())
  // A refresh request may legitimately take longer than the former two-second wait.
  await new Promise(resolve => setTimeout(resolve, 2300))
  expect(await second.evaluate(() => window.refreshSettled), 'a pending sibling refresh cannot claim success with an expired token').toBe(false)
  expect(await queue(first)).toEqual(beforeSlow)
  await Promise.all([navigate(first, '/projects'), navigate(second, '/processes')])
  releaseRefresh(); delayRefresh = false
  expect(await owner).toBe(true)
  expect(await sibling).toBe(true)
  await pendingSync
  expect(await queue(first)).toHaveLength(0)
  expect((await tasks()).filter(row => row.title === nameD)).toHaveLength(1)
  await expect.poll(() => second.evaluate(() => window.mt.auth.accessExpired())).toBe(false)
  report.push('PASS slow shared refresh: cached navigation stays responsive and requests wait for a valid token')
  await navigate(first, '/planner')
  await second.evaluate(async () => {
    window.holdsSessionLock = false
    window.holdSessionLock = navigator.locks.request('mvs_erp_refresh', () => new Promise(resolve => {
      window.releaseSessionLock = resolve
      window.holdsSessionLock = true
    }))
  })
  await expect.poll(() => second.evaluate(() => window.holdsSessionLock)).toBe(true)
  await first.reload()
  await expect(first.locator('.ah-burger'), 'cached account startup cannot wait forever for a suspended sibling').toBeVisible({ timeout: 4000 })
  await expect(first.locator('body')).toContainText(nameD)
  await second.evaluate(() => window.releaseSessionLock())
  await runtime(first)
  await expect.poll(() => first.evaluate(() => window.mt.auth.accessExpired())).toBe(false)
  report.push('PASS cold reload with a suspended refresh owner: cached interface opens before the lock is released')
  await first.evaluate(async () => {
    await window.mt.outbox.enqueueMutation({
      entity: 'task', method: 'PUT', url: location.origin + '/api/v1/task/2147483647',
      body: { title: 'Rejected disposable fixture' },
    })
    await window.mt.sync.syncNow()
  })
  expect((await queue(first))[0].quarantined).toBe(true)
  await setOffline(first, true)
  const nameE = `${prefix}-E-pending`
  await createOffline(first, nameE)
  const rejectedQueue = await queue(first)
  expect(rejectedQueue).toHaveLength(2)
  await setOffline(first, false)
  await first.evaluate(() => window.mt.db.idbClear('cache'))
  await first.reload()
  await expect(first.locator('.ah-burger')).toBeVisible({ timeout: 4000 })
  await runtime(first)
  await expect(first.locator('body'), 'a preserved rejected edit cannot blank freshly loaded planning data').toContainText(nameD, { timeout: 8000 })
  await expect(first.locator('body')).toContainText(nameE)
  expect((await tasks()).some(row => row.title === nameE)).toBe(false)
  expect(await queue(first)).toEqual(rejectedQueue)
  report.push('PASS missing cache with a quarantined mutation: backend data renders and the rejected edit remains intact')
  expect(errors).toEqual([])
  console.log(report.join('\n'))
  console.log(`PASS multi-tab offline: ${transitions} real menu transitions; disposable user and data only`)
} catch (error) {
  console.error(report.join('\n'))
  console.error('Mutation transport:', sends)
  throw error
} finally {
  apiOffline = false
  releaseRefresh()
  await browser.close()
  if (projectId) expect((await call(admin, 'DELETE', `project/${projectId}`)).status, 'remove fixture project').toBe(204)
  if (userId) expect((await call(admin, 'DELETE', `user/${userId}`)).status, 'remove fixture user').toBe(204)
  await http.dispose()
}
