import { chromium, expect, request } from 'playwright/test'

const apiURL = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const webURL = process.env.RBAC_TEST_WEB_URL ?? 'http://127.0.0.1:5173'
for (const url of [apiURL, webURL]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Local fixtures only')
if (!process.env.RBAC_TEST_ADMIN_PASSWORD) throw new Error('Set RBAC_TEST_ADMIN_PASSWORD')
const http = await request.newContext({ baseURL: `${apiURL}/` })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.addInitScript(() => localStorage.setItem('mvs_erp_auto_sync', '0'))
const prefix = `ar${Date.now()}`
const cleanup = [], errors = []
let admin, token, uid, checks = 0
page.on('pageerror', error => errors.push(error.message))
const grant = (resource, action) => ({ resource, action, scope: 'all', granted: true })
async function call(who, method, path, data) {
  for (let n = 0; n < 10; n++) {
    await new Promise(r => setTimeout(r, 125))
    const reply = await http.fetch(path, { method, data, headers: who ? { Authorization: `Bearer ${who}` } : {} })
    if (reply.status() === 429) { await new Promise(r => setTimeout(r, 1000)); continue }
    const text = await reply.text()
    return { status: reply.status(), ...(text ? JSON.parse(text) : {}) }
  }
  throw new Error('Rate limit did not recover')
}
function check(actual, expected, label) { expect(actual, label).toEqual(expected); checks++ }
async function rights(rules) {
  check((await call(admin, 'PUT', `rbac/users/${uid}/permissions`, { overrides: rules })).status, 200, 'save individual permissions')
}
async function navigate(path) { await page.evaluate(path => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path), path) }
async function login(username, password) {
  await page.goto(`${webURL}/login`)
  await page.locator('input[autocomplete=username]').fill(username)
  await page.locator('input[autocomplete=current-password]').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login$/)
  await page.evaluate(async () => { const store = await import('/src/store/index.ts'); window.adminRightsRouter = document.querySelector('#app').__vue_app__.config.globalProperties.$router; await store.useRbacStore().refreshPermissions() })
}
const rows = [
  ['accounts-view', 'user_admin', ['view']], ['accounts-manage', 'user_admin', ['create', 'update', 'delete']],
  ['roles', 'rbac_config', ['update']], ['template', 'auto_create', ['view', 'update']],
  ['day-types', 'state', ['create', 'update', 'delete']], ['structure', 'org_structure', ['view']], ['audit', 'audit', ['view']],
]
try {
  const signed = await call(null, 'POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD })
  check(signed.status, 200, 'admin login'); admin = signed.data.access_token
  const created = await call(admin, 'POST', 'user', { username: prefix, first_name: 'Permissions', last_name: 'Test', preset: 'worker' })
  check(created.status, 201, 'subject'); uid = created.data.user.id
  cleanup.push(() => call(admin, 'DELETE', `user/${uid}`))
  const subject = await call(null, 'POST', 'auth/login', { username: prefix, password: created.data.password })
  check(subject.status, 200, 'subject login'); token = subject.data.access_token
  const dayType = await call(admin, 'POST', 'timesheet/states', { code: prefix, name: prefix, is_available: false })
  check(dayType.status, 201, 'temporary day type')
  cleanup.push(() => call(admin, 'DELETE', `timesheet/states/${dayType.data.id}`))
  // Real routes must enforce independent capabilities, not just hide navigation.
  const probes = [
    ['user_admin', 'view', 'user/accounts', 200],
    ['org_structure', 'view', 'user/structure', 200],
    ['user_catalog', 'view', 'user/all', 200],
    ['rbac_config', 'update', 'rbac/matrix', 200],
    ['auto_create', 'view', 'auto-create/config', 200],
    ['auto_create', 'update', 'auto-create/config', 200],
    ['state', 'view', 'timesheet/states', 200],
  ]
  for (const [resource, action, allowed] of probes) {
    await rights([grant(resource, action)])
    for (const [, , path] of probes) {
      const reply = await call(token, 'GET', path)
      const shouldAllow = path === allowed || (resource === 'rbac_config' && path === 'user/accounts')
      check(shouldAllow ? reply.status : [403, 404].includes(reply.status), shouldAllow ? 200 : true, `${resource}/${action} -> ${path}`)
      if (path === 'user/structure' && shouldAllow) {
        check(Array.isArray(reply.data), true, 'structure array')
        check(reply.data.some(row => Object.keys(row).some(key => ['username', 'password_hash', 'hire_date', 'created_at'].includes(key))), false, 'structure excludes private account fields')
      }
    }
    check((await call(token, 'GET', 'user/accounts?include_hash=true')).status, 403, 'no non-admin password hashes')
    check((await call(token, 'GET', `user/accounts/${uid}`)).status, ['user_admin', 'rbac_config'].includes(resource) ? 200 : 403, 'direct account profile access')
    check([403, 404].includes((await call(token, 'GET', `user/${uid}/days?start=2026-11-01&end=2026-11-30`)).status), true, 'administration does not open employee calendar')
    // A template read grant cannot write or configure roles; dictionary use cannot create day types.
    for (const [path, data, enabled] of [
      ['auto-create/config', { processes: 'invalid' }, resource === 'auto_create' && action === 'update'],
      ['rbac/preset-rules', {}, resource === 'rbac_config'],
      ['timesheet/states', {}, false],
    ]) {
      const reply = await call(token, path === 'timesheet/states' ? 'POST' : 'PUT', path, data)
      check(reply.status, enabled ? 400 : 403, `write isolation ${resource} -> ${path}`)
    }
  }
  for (const [, , path] of probes) check((await call(null, 'GET', path)).status, 401, 'anonymous blocked')
  await rights([grant('worker', 'view'), grant('state', 'view'), grant('worker', 'update')])
  await login(prefix, created.data.password)
  await navigate('/timesheet')
  await expect(page.locator('.tp-day-types')).toHaveCount(0)
  await expect(page.locator('a[href="/statuses"]')).toHaveCount(0)
  checks++
  for (const action of ['create', 'update', 'delete']) {
    await rights([grant('state', 'view'), grant('state', action)])
    await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().refreshPermissions())
    await navigate('/timesheet')
    await expect(page.locator('.tp-day-types')).toHaveCount(1)
    await expect(page.locator('.tp-filters')).toHaveCount(0)
    if (await page.locator('.tp-day-types').getAttribute('aria-expanded') === 'false') await page.locator('.tp-day-types').click()
    await expect(page.locator('.sp .dt-card')).toBeVisible()
    await expect(page.locator('.sp .tbar-add')).toHaveCount(action === 'create' ? 1 : 0)
    const row = page.locator('.sp .dt-tr').filter({ hasText: prefix }).first()
    await row.dispatchEvent('contextmenu', { button: 2, bubbles: true, clientX: 650, clientY: 400 })
    await expect(page.getByRole('menuitem')).toHaveCount(action === 'create' ? 0 : 1)
    await page.mouse.click(1400, 950); await page.keyboard.press('Escape')
    checks++
  }
  await navigate('/statuses')
  await expect(page).toHaveURL(/\/timesheet$/)
  await rights([grant('worker', 'view'), grant('state', 'view')])
  await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().refreshPermissions())
  await expect(page.locator('.tp-day-types, .sp')).toHaveCount(0)
  checks++
  await rights([grant('auto_create', 'view')])
  await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().refreshPermissions())
  await navigate('/auto-create')
  await expect(page.locator('.ac-enable input')).toBeDisabled()
  await expect(page.locator('.ac-save')).toHaveCount(0); checks++
  await rights([grant('auto_create', 'update')])
  await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().refreshPermissions())
  await expect(page.locator('.ac-enable input')).toBeEnabled(); checks++
  await rights([])
  await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().refreshPermissions())
  await expect(page).toHaveURL(/\/profile$/); checks++
  await page.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().logout())
  await login('admin', process.env.RBAC_TEST_ADMIN_PASSWORD)
  check((await call(admin, 'POST', 'rbac/presets', { tag: prefix, name: prefix })).status, 201, 'temporary role')
  cleanup.push(() => call(admin, 'DELETE', `rbac/presets/${prefix}`))
  await navigate('/permissions')
  await page.evaluate(async () => (await import('/src/store/index.ts')).useRbacStore().loadRbac())
  await page.locator('.pm-preset-btn').filter({ hasText: prefix }).click()
  const card = page.locator('.pm-block[data-resource=administration]')
  await expect(card).toHaveCount(1)
  await expect(card.locator('.pm-row')).toHaveCount(7); checks++
  // Role creation has no administrative defaults; each choice touches only its physical permission keys.
  for (const [key] of rows) {
    await card.locator(`[data-action-group="${key}"] .pm-chip:not(.rev)`).click()
  }
  await page.locator('.pm-savebar-actions .primary').click()
  await expect(page.locator('.pm-savebar-actions .primary')).toHaveCount(0)
  const saved = (await call(admin, 'GET', 'rbac/preset-rules')).data
  const rules = (saved.items ?? saved).filter(row => row.preset === prefix)
  for (const [, resource, actions] of rows) for (const action of actions) check(rules.some(rule => rule.resource === resource && rule.action === action && rule.scope === 'all'), true, `${resource}/${action} persisted`)
  await new Promise(r => setTimeout(r, 1000))
  await page.reload()
  await page.locator('.pm-preset-btn').filter({ hasText: prefix }).click()
  for (const [key] of rows) await expect(card.locator(`[data-action-group="${key}"] .pm-chip:not(.rev)`)).toHaveAttribute('aria-pressed', 'true')
  checks++
  await card.screenshot({ path: '/tmp/erp-administration-permissions.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile overflow')
  await page.setViewportSize({ width: 1440, height: 1000 })
  // A rejected save preserves the draft and leaves persisted rules intact.
  await card.locator('[data-action-group=roles] .pm-chip.rev').click()
  await page.route('**/api/v1/rbac/preset-rules/*', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 403, json: { data: {}, error: { code: 'FORBIDDEN', message: 'Denied' } } }) : route.continue())
  await page.locator('.pm-savebar-actions .primary').click()
  await expect(page.locator('.pm-savebar-actions .primary')).toBeVisible()
  await expect(card.locator('[data-action-group=roles] .pm-chip.rev')).toHaveAttribute('aria-pressed', 'true')
  check(((await call(admin, 'GET', 'rbac/preset-rules')).data).some(rule => rule.preset === prefix && rule.resource === 'rbac_config'), true, 'failed save did not change server')
  await page.unroute('**/api/v1/rbac/preset-rules/*')
  await page.locator('.pm-savebar-actions .pm-btn:not(.primary)').click()
  await expect(card.locator('[data-action-group=roles] .pm-chip:not(.rev)')).toHaveAttribute('aria-pressed', 'true')
  // The individual editor persists the same seven settings independently of the role editor.
  await navigate(`/users/${uid}/edit/access`)
  const individual = page.locator('.uped-res-card[data-resource=administration]')
  await expect(individual.locator('.ur-row')).toHaveCount(7)
  for (const [key] of rows) await individual.locator(`[data-action-group="${key}"] [data-scope=all]`).click()
  await page.locator('.ua-save').click()
  await expect(page.locator('.ua-save')).toHaveCount(0)
  let overrides = (await call(admin, 'GET', `rbac/users/${uid}/permissions`)).data.overrides
  for (const [, resource, actions] of rows) for (const action of actions) check(overrides.some(rule => rule.resource === resource && rule.action === action && rule.granted), true, `individual ${resource}/${action} persisted`)
  await new Promise(r => setTimeout(r, 1000))
  await page.reload()
  for (const [key] of rows) await expect(individual.locator(`[data-action-group="${key}"] [data-scope=all]`)).toHaveAttribute('aria-pressed', 'true')
  // Revert a single capability while preserving every other individual grant.
  await individual.locator('[data-action-group=roles] .ur-revert').click()
  await page.locator('.ua-save').click()
  await expect(page.locator('.ua-save')).toHaveCount(0)
  overrides = (await call(admin, 'GET', `rbac/users/${uid}/permissions`)).data.overrides
  check(overrides.some(rule => rule.resource === 'rbac_config'), false, 'revert removes only the roles override')
  check(overrides.some(rule => rule.resource === 'auto_create' && rule.action === 'update' && rule.granted), true, 'template override survives roles revert')
  await individual.locator('[data-action-group=template] [data-scope=none]').click()
  await page.route(`**/api/v1/rbac/users/${uid}/permissions`, route => route.request().method() === 'PUT' ? route.fulfill({ status: 403, json: { data: {}, error: { code: 'FORBIDDEN', message: 'Denied' } } }) : route.continue())
  await page.locator('.ua-save').click()
  await expect(page.locator('.ua-save')).toBeEnabled()
  await expect(individual.locator('[data-action-group=template] [data-scope=none]')).toHaveAttribute('aria-pressed', 'true')
  await page.unroute(`**/api/v1/rbac/users/${uid}/permissions`)
  await page.locator('.ua-cancel').click()
  await expect(individual.locator('[data-action-group=template] [data-scope=all]')).toHaveAttribute('aria-pressed', 'true')
  check(errors, [], 'no browser runtime errors')
  console.log(`PASS administration: ${checks} real API/browser checks, independent grants, read-only legacy, persistence, rejection and mobile layout`)
} catch (error) {
  console.error('Administration test failed at', page.url(), error.message)
  await page.screenshot({ path: '/tmp/erp-admin-failed.png', timeout: 5000 }).catch(() => {})
  throw error
} finally {
  await browser.close()
  const results = await Promise.allSettled(cleanup.reverse().map(remove => remove()))
  if (results.some(result => result.status === 'rejected')) throw new Error('Fixture cleanup failed')
  await http.dispose()
}
