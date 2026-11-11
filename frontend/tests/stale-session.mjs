import fs from 'node:fs'
import { chromium, expect, request } from 'playwright/test'

const web = process.env.ERP_TEST_URL ?? 'http://localhost:5173'
const api = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
for (const url of [web, api]) if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Session fixtures require loopback URLs')
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]
}))
const prefix = 'ss' + Date.now()
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript(origin => { if (location.origin === origin) localStorage.setItem('mvs_erp_auto_sync', '0') }, new URL(web).origin)
const http = await request.newContext({ baseURL: api + '/' })
const errors = []
context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
let token, user, project, refreshes = 0
context.on('request', req => { if (new URL(req.url()).pathname.endsWith('/auth/refresh')) refreshes++ })
async function call(method, path, data) {
  for (let n = 0; n < 10; n++) {
    const response = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    expect(response.status(), method + ' ' + path).toBe(method === 'DELETE' ? 204 : method === 'POST' && path !== 'auth/login' ? 201 : 200)
    return response.status() === 204 ? null : (await response.json()).data
  }
  throw new Error('Fixture rate limit')
}
async function runtime(page) {
  await page.evaluate(async () => {
    const s = await import('/src/store/index.ts')
    window.ss = { auth: s.useAuthStore(), planning: s.usePlanningStore(), db: await import('/src/offline/db.ts'), token: await import('/src/token.ts'), state: await import('/src/offline/state.ts'), sync: await import('/src/offline/sync.ts') }
  })
}
async function login(page) {
  await page.locator('input[autocomplete=username]').fill(user.user.username)
  await page.locator('input[autocomplete=current-password]').fill(user.password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await expect(page.locator('.ah-burger')).toBeVisible()
}
async function menu(page, path, expected = new RegExp(path + '$')) {
  const nav = page.locator('.nd')
  if (!/nd--open/.test(await nav.getAttribute('class'))) await page.locator('.ah-burger').click()
  const link = nav.locator('a[href="' + path + '"]')
  if (!await link.isVisible()) await link.locator('xpath=ancestor::section').locator('.nd-group-head').click()
  await link.click()
  await expect(page).toHaveURL(expected)
}
const queue = page => page.evaluate(() => window.ss.db.idbAll('outbox'))
try {
  token = (await call('POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD ?? env.ADMIN_PASSWORD })).access_token
  user = await call('POST', 'user', { username: prefix, first_name: 'Session', last_name: 'Fixture', preset: 'vp' })
  const dates = { start_date: '2026-11-01', end_date: '2026-12-31', owner_id: user.user.id }
  project = await call('POST', 'project', { ...dates, code: prefix })
  const fixtureProcess = await call('POST', 'process', { ...dates, project_id: project.id, title: prefix + '-process' })
  await call('POST', 'task', { ...dates, process_id: fixtureProcess.id, title: prefix + '-server' })
  const first = await context.newPage()
  await first.goto(web + '/login')
  await login(first)
  await runtime(first)
  await first.evaluate(() => window.ss.planning.refreshTaskPlanning())
  const second = await context.newPage()
  await second.goto(web + '/planner')
  await expect(second.locator('.ah-burger')).toBeVisible()
  await runtime(second)
  expect(await first.evaluate(async ({ processId, title }) => {
    window.ss.state.isOffline.value = true
    const ok = await window.ss.planning.createTask({ process_id: processId, title, start_date: '2026-11-09', end_date: '2026-11-22' })
    window.ss.state.isOffline.value = false
    await window.ss.db.idbClear('cache')
    return ok
  }, { processId: fixtureProcess.id, title: prefix + '-queued' })).toBe(true)
  const before = await queue(first)
  expect(before).toHaveLength(1)
  const baseline = refreshes
  await second.evaluate(() => localStorage.setItem('mvs_erp_logged_out', '1'))
  await first.evaluate(async () => {
    window.ss.token.setAccessToken(null)
    await window.ss.planning.refreshTaskPlanning()
  })
  await expect(first).toHaveURL(/\/login/)
  expect(await first.evaluate(() => window.ss.auth.isAuthenticated)).toBe(false)
  expect(await queue(first)).toEqual(before)
  await menu(second, '/projects', /\/login/)
  await expect(second).toHaveURL(/\/login/)
  expect(refreshes).toBe(baseline)
  expect(await queue(second)).toEqual(before)
  console.log('PASS live 401: stale cached profile and logout flag reach login without refresh or redirect loops; both tabs retain the original queue')
  await first.reload()
  await expect(first).toHaveURL(/\/login/)
  await runtime(first)
  expect(await queue(first)).toEqual(before)
  await login(first)
  await first.reload()
  await expect(first.locator('.ah-burger')).toBeVisible()
  await runtime(first)
  await expect(first.locator('body')).toContainText(prefix + '-server', { timeout: 15000 })
  await expect(first.locator('body')).toContainText(prefix + '-queued', { timeout: 15000 })
  expect(await queue(first)).toEqual(before)
  expect(await first.evaluate(() => localStorage.getItem('mvs_erp_logged_out'))).toBeNull()
  await first.evaluate(() => window.ss.sync.syncNow())
  expect(await queue(first)).toHaveLength(0)
  console.log('PASS verified re-login: server and queued tasks render after reload, logout clears before navigation and sync commits the queued task')
  await second.goto(web + '/projects')
  await expect(second.locator('body')).toContainText(prefix, { timeout: 15000 })
  await menu(second, '/processes')
  await expect(second.locator('body')).toContainText(prefix + '-process', { timeout: 15000 })
  await menu(second, '/planner')
  await expect(second.locator('body')).toContainText(prefix + '-queued', { timeout: 15000 })
  expect(errors).toEqual([])
  console.log('PASS sibling tab: restores the new shared session and navigates through populated projects, processes and tasks')
} finally {
  await browser.close()
  if (project) await call('DELETE', 'project/' + project.id)
  if (user) await call('DELETE', 'user/' + user.user.id)
  await http.dispose()
}
