import { chromium, expect } from 'playwright/test'
import { launchElectronFixture } from './helpers/electron.mjs'

const base = process.env.ERP_TEST_URL
const password = process.env.ERP_TEST_PASSWORD
if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname) || !password) throw new Error('An explicit local test URL and password are required')
const desktop = process.env.ERP_TEST_DESKTOP === '1'
let native = null
const browser = desktop ? null : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const report = []
async function navigate(page, path) {
  const nav = page.locator('.nd')
  if (!/nd--open/.test(await nav.getAttribute('class'))) await page.locator('.ah-burger').click()
  const link = nav.locator(`a[href="${path}"]`)
  if (!await link.isVisible()) await link.locator('xpath=ancestor::section').locator('.nd-group-head').click()
  await link.click()
  await expect(page).toHaveURL(new RegExp(path + '$'))
  await expect(link).toHaveClass(/active/)
}
try {
  for (const mode of desktop ? ['healthy', 'missing'] : ['healthy', 'missing', 'throwing', 'stalled', 'rotation-failure']) {
    const storageBlocked = ['missing', 'throwing', 'stalled'].includes(mode)
    console.log('BOOTSTRAP', desktop ? 'desktop' : 'web', mode)
    if (desktop) native = await launchElectronFixture()
    const context = native ? native.app.context() : await browser.newContext()
    if (native) { await context.clearCookies(); await context.clearPermissions() }
    await context.addInitScript(({ mode }) => {
      localStorage.setItem('mvs_erp_auto_sync', '0')
      if (mode === 'missing') Object.defineProperty(window, 'indexedDB', { value: undefined })
      if (mode === 'throwing') Object.defineProperty(window, 'indexedDB', { value: { open() { throw new DOMException('Blocked', 'SecurityError') } } })
      if (mode === 'stalled') Object.defineProperty(window, 'indexedDB', { value: { open() { return {} } } })
    }, { mode })
    const page = native ? await native.app.firstWindow() : await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = [], refreshBodies = []
    page.on('pageerror', error => { errors.push(error.message); console.error('[bootstrap]', mode, error.stack) })
    context.on('request', request => { if (new URL(request.url()).pathname.endsWith('/auth/refresh')) refreshBodies.push(request.postData()) })
    const start = performance.now()
    await page.goto(base + '/login')
    await expect(page.locator('input[autocomplete=username]')).toBeVisible()
    await expect(page.locator('.boot-splash')).toHaveCount(0)
    expect(performance.now() - start).toBeLessThan(8000)
    const runtime = await page.evaluate(async () => {
      const { currentRuntime } = await import('/src/platform/current.ts')
      const { platformCapabilities } = await import('/src/platform/context.ts')
      return { kind: currentRuntime.value?.kind, caps: platformCapabilities }
    })
    expect(runtime.kind).toBe(desktop ? 'desktop' : 'web')
    expect(runtime.caps.serverSelection).toBe(desktop)
    await page.locator('input[autocomplete=username]').fill('admin')
    await page.locator('input[autocomplete=current-password]').fill(password)
    await page.locator('button[type=submit]').click()
    if (desktop && mode !== 'healthy') {
      await expect(page.locator('button[type=submit]')).toBeEnabled()
      await expect(page).toHaveURL(/\/login$/)
      expect(await page.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().isAuthenticated)).toBe(false)
      expect(errors).toEqual([])
      report.push({ platform: 'desktop', mode, result: 'durable business storage failure remains explicit; session secrets are not stored in IndexedDB' })
      await native.close(); native = null
      continue
    }
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('.ah-burger')).toBeVisible()
    await navigate(page, '/projects')
    await expect(page).toHaveURL(/\/projects$/)
    const fetched = await page.evaluate(async () => {
      const { useAppStore, useRbacStore } = await import('/src/store/index.ts')
      const app = useAppStore()
      await useRbacStore().refreshPermissions(); await app.refreshProjects()
      return { error: app.projectsError, projects: app.projects }
    })
    expect(fetched.error).toBeNull()
    expect(Array.isArray(fetched.projects)).toBe(true)
    for (const path of ['/processes', '/timesheet', '/planner', '/system/queue']) {
      await navigate(page, path)
      await expect(page).toHaveURL(new RegExp(path + '$'))
    }
    if (storageBlocked) {
      await expect(page.locator('.sq [role=status]')).toContainText(/очеред|queue/i)
      await expect(page.locator('.sq')).not.toContainText(/Очередь пуста|Queue is empty/)
      expect(await page.evaluate(() => localStorage.getItem('mvs_erp_session_state'))).toBeNull()
    }
    await page.reload()
    await expect(page.locator('.ah-burger')).toBeVisible()
    await expect(page).not.toHaveURL(/\/login/)
    const sibling = native ? null : await context.newPage()
    if (sibling) {
      await sibling.goto(base + '/projects')
      await expect(sibling.locator('.ah-burger')).toBeVisible()
      const results = await Promise.all([page, sibling].map(tab => tab.evaluate(async () => {
        const store = await import('/src/store/index.ts')
        return store.useAuthStore().refreshSession()
      })))
      expect(results).toEqual([true, true])
      if (mode === 'rotation-failure') {
        await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { value: { open() { throw new DOMException('Rotation storage failed', 'SecurityError') } } }))
        expect(await page.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().refreshSession())).toBe(true)
        expect(await sibling.evaluate(() => localStorage.getItem('mvs_erp_session_state'))).toBeNull()
        expect(await sibling.evaluate(async () => (await import('/src/offline/session.ts')).loadRefreshToken())).toBeNull()
        const afterRotation = refreshBodies.length
        expect(await sibling.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().refreshSession())).toBe(true)
        expect(refreshBodies.length).toBeGreaterThan(afterRotation)
        expect(refreshBodies.slice(afterRotation).every(body => !body || !JSON.parse(body).refresh_token)).toBe(true)
        await navigate(page, '/projects')
        await navigate(sibling, '/processes')
      }
      await sibling.close()
    }
    if (storageBlocked && !desktop) {
      expect(refreshBodies.length).toBeGreaterThan(0)
      expect(refreshBodies.every(body => !body || !JSON.parse(body).refresh_token)).toBe(true)
    }
    expect(errors).toEqual([])
    report.push({ platform: desktop ? 'desktop' : 'web', mode, result: 'boot, login, routes, API data, reload and session refresh passed' })
    if (native) { await native.close(); native = null } else await context.close()
  }
  console.log(JSON.stringify({ cases: report.length, report }, null, 2))
} finally {
  if (native) await native.close()
  if (browser) await browser.close()
}
