import { chromium, expect } from 'playwright/test'

const web = process.env.ERP_TEST_URL, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !web || !['localhost', '127.0.0.1'].includes(new URL(web).hostname)) throw new Error('An explicit isolated local web URL and password are required')
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const report = [], errors = []
async function login(page) {
  await page.goto(web + '/login')
  await page.locator('input[autocomplete=username]').fill('admin')
  await page.locator('input[autocomplete=current-password]').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page.locator('.ah-burger')).toBeVisible()
  await expect(page).not.toHaveURL(/\/login/)
}
async function legacyRows(page, write = false) {
  return page.evaluate(async write => {
    const factory = window.legacyFixtureFactory
    const db = await new Promise((resolve, reject) => {
      const request = factory.open('erp-offline', 4)
      request.onupgradeneeded = () => { for (const store of ['cache', 'outbox', 'idmap', 'session']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store) }
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      if (write) await new Promise((resolve, reject) => {
        const tx = db.transaction(['cache', 'outbox', 'idmap', 'session'], 'readwrite')
        tx.objectStore('outbox').put({ id: 'old-own', entity: 'task', method: 'POST', url: '/api/v1/task', body: { title: 'Old unsent', process_id: 999999 }, creator: 'admin', ts: 1, tempId: -190001, idempotencyKey: 'old-key' }, 'old-own')
        tx.objectStore('outbox').put({ id: 'old-foreign', entity: 'task', method: 'DELETE', url: '/api/v1/task/999999', creator: 'another-account', ts: 2, quarantined: true }, 'old-foreign')
        tx.objectStore('idmap').put({ temp: -190001, real: 999999 }, '-190001')
        tx.objectStore('session').put('old-revoked-token', 'refresh')
        tx.objectStore('cache').put({ ts: 1, data: { data: { projects: [{ id: 999999, project_code: 'OLD-BROWSER-ONLY' }] } } }, 'u1:/api/v1/planning/projects')
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error)
      })
      const rows = {}
      for (const store of ['cache', 'outbox', 'idmap', 'session']) rows[store] = await new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      return rows
    } finally { db.close() }
  }, write)
}
try {
  for (const mode of ['missing', 'throwing', 'stalled', 'legacy-pending']) {
    console.log('RETIREMENT', mode)
    const context = await browser.newContext()
    try {
      const requests = []
      await context.addInitScript(({ mode, origin }) => {
        if (location.origin !== origin) return
        localStorage.setItem('mvs_erp_auto_sync', '0')
        localStorage.setItem('mvs_erp_ui_lang', 'ru')
        const native = window.indexedDB
        window.legacyFixtureFactory = native
        window.legacyStorageCalls = []
        let value
        if (mode === 'legacy-pending') value = { open(...args) { window.legacyStorageCalls.push('open'); return native.open(...args) }, deleteDatabase(...args) { window.legacyStorageCalls.push('delete'); return native.deleteDatabase(...args) } }
        if (mode === 'stalled') value = { open() { window.legacyStorageCalls.push('stalled'); return {} } }
        Object.defineProperty(window, 'indexedDB', { configurable: true, get() {
          window.legacyStorageCalls.push('access')
          if (mode === 'throwing') throw new DOMException('Blocked', 'SecurityError')
          return value
        } })
      }, { mode, origin: new URL(web).origin })
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      context.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/v1/')) requests.push({ path, method: request.method() }) })
      const page = await context.newPage(); page.setDefaultTimeout(15000)
      await page.goto(web + '/login')
      let before
      if (mode === 'legacy-pending') { before = await legacyRows(page, true); await page.reload() }
      await login(page)
      await expect(page.locator('.nd a[href="/system/queue"]')).toHaveCount(0)
      for (const path of ['/system/queue', '/system/console', '/system/status']) {
        await page.evaluate(async path => (await import('/src/router/index.ts')).default.push(path), path)
        await expect(page).toHaveURL(/\/system\/settings$/)
        await expect(page.locator('.sq, .sc, .ss')).toHaveCount(0)
      }
      await page.getByRole('tab', { name: 'Обновление данных', exact: true }).click()
      await expect(page.getByText('Автоматически обновлять данные раз в минуту', { exact: true })).toBeVisible()
      await expect(page.locator('input[placeholder="https://host/api/v1"]')).toHaveCount(0)
      const sibling = await context.newPage(); await sibling.goto(web + '/projects')
      await expect(sibling.locator('.ah-burger')).toBeVisible()
      await Promise.all([page, sibling].map(tab => tab.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().waitForSessionRefresh())))
      const refreshed = await Promise.all([page, sibling].map(tab => tab.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().refreshSession())))
      expect(refreshed).toEqual([true, true])
      for (const tab of [page, sibling]) {
        expect(await tab.evaluate(() => window.legacyStorageCalls)).toEqual([])
        await tab.reload(); await expect(tab.locator('.ah-burger')).toBeVisible()
        expect(await tab.evaluate(() => window.legacyStorageCalls)).toEqual([])
      }
      report.push(`PASS ${mode}: login, hidden desktop tools/direct URLs, two-tab cookie refresh and reload never touch IndexedDB`)
      if (mode === 'legacy-pending') {
        expect(await legacyRows(page)).toEqual(before)
        await page.bringToFront()
        await page.goto(web + '/projects')
        await page.evaluate(async () => { const store = await import('/src/store/index.ts'); await store.usePlanningStore().refreshProjectPlanning(true); window.retirementStore = store })
        expect(await page.locator('body').textContent()).not.toContain('OLD-BROWSER-ONLY')
        await page.evaluate(async () => {
          const router = (await import('/src/router/index.ts')).default
          await router.push('/processes'); await router.push('/projects')
        })
        await context.setOffline(true)
        await expect.poll(() => sibling.evaluate(async () => (await import('/src/offline/state.ts')).isOffline.value)).toBe(true)
        await page.evaluate(async () => {
          window.dispatchEvent(new Event('offline'))
          await (await import('/src/router/index.ts')).default.push('/processes')
        })
        await expect(page).toHaveURL(/\/processes$/)
        expect(await page.evaluate(async () => window.retirementStore.useAppStore().createResource({ code: 'retired-offline', title: 'Must not enqueue', owner_id: window.retirementStore.useAuthStore().user.id }))).toBe(false)
        await context.setOffline(false)
        await page.evaluate(async () => { (await import('/src/settings.ts')).autoSync.value = true })
        await Promise.all([page, sibling].map(tab => tab.evaluate(() => window.dispatchEvent(new Event('online')))))
        await expect.poll(() => page.evaluate(async () => (await import('/src/offline/state.ts')).isOffline.value)).toBe(false)
        await expect.poll(() => sibling.evaluate(async () => (await import('/src/offline/state.ts')).isOffline.value)).toBe(false)
        expect(await Promise.all([page, sibling].map(tab => tab.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().refreshSession())))).toEqual([true, true])
        expect(await legacyRows(page)).toEqual(before)
        expect(requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method) && row.path.includes('/task'))).toEqual([])
        report.push('PASS old pending/quarantined commands, ID map, cache and refresh token remain unchanged through offline edits and reconnect; nothing is replayed')
        await page.waitForLoadState('networkidle')
        await page.evaluate(async () => {
          const { currentRuntime } = await import('/src/platform/current.ts')
          currentRuntime.value.stop()
          const runtime = (await import('/src/platform/web.ts')).createWebRuntime()
          currentRuntime.value = runtime
          await runtime.start()
        })
        const pulls = requests.filter(row => row.method === 'GET' && row.path.includes('/planning/')).length
        const since = Date.now()
        await expect.poll(() => requests.filter(row => row.method === 'GET' && row.path.includes('/planning/')).length, { timeout: 75000, intervals: [1000] }).toBeGreaterThan(pulls)
        expect(Date.now() - since).toBeGreaterThanOrEqual(55000)
        expect(await legacyRows(page)).toEqual(before)
        expect(await page.evaluate(() => window.legacyStorageCalls)).toEqual([])
        report.push('PASS minute API refresh continues with a nonempty old browser outbox and no IndexedDB discovery')
        await sibling.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().logout())
        await expect.poll(() => page.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().isAuthenticated)).toBe(false)
        expect(await legacyRows(page)).toEqual(before)
        expect(await page.evaluate(() => window.legacyStorageCalls)).toEqual([])
        report.push('PASS cross-tab logout neither prunes nor clears previous IndexedDB data')
      }
    } finally { await context.close() }
  }
  expect(errors).toEqual([])
  console.log(JSON.stringify({ cases: report.length, report }, null, 2))
} finally { await browser.close() }
