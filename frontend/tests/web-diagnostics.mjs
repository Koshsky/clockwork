// Isolated HTTP fixtures only; this suite never contacts an application backend.
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect } from 'playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rendererBuildComposition } from '../scripts/build-targets.mjs'
import { readVersion } from '../scripts/app-version.cjs'
import { PDFDocument } from 'pdf-lib'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const { webPolicy, securityHeaders } = createRequire(import.meta.url)('../desktop/security.cjs')
const server = await createServer({
  root, configFile: false, cacheDir: path.join(root, 'node_modules/.vite-o08-diagnostics'),
  plugins: [vue(), rendererBuildComposition('web', readVersion())],
  resolve: { alias: { '@': path.join(root, 'src') } },
  define: { __APP_VERSION__: JSON.stringify(readVersion()), 'import.meta.env.VITE_API_URL': JSON.stringify('/api/v1') },
  server: { host: '127.0.0.1', port: 0, hmr: false, headers: securityHeaders(webPolicy) },
})
let browser
try {
  await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })
  let authenticated = false
  const user = { id: 701, username: 'fixture', first_name: 'Private', last_name: 'Canary', preset: 'admin' }
  const access = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture'
  const permissions = ['project', 'process', 'task', 'resource', 'assignment', 'milestone', 'worker', 'user'].flatMap(resource => ['view', 'create', 'update', 'delete'].map(action => ({ resource, action, scope: 'all' })))
  const requests = [], foreign = [], violations = [], errors = []
  context.on('request', request => {
    const url = new URL(request.url())
    if (url.origin !== base && !['data:', 'blob:'].includes(url.protocol)) foreign.push(url.origin)
    if (url.pathname.startsWith('/api/')) requests.push(url.pathname)
  })
  await context.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), name = url.pathname
    let data = {}, status = 200
    if (name.endsWith('/auth/login')) { authenticated = true; data = { access_token: access, user } }
    else if (name.endsWith('/auth/refresh')) { status = authenticated ? 200 : 401; data = authenticated ? { access_token: access, user } : {} }
    else if (name.endsWith('/about')) data = { version: '1.6.0', changelog_ru: 'private-canary', changelog_en: 'private-canary' }
    else if (name.endsWith('/permissions/me')) data = permissions
    else if (/\/user\/\d+$/.test(name)) data = user
    else if (name.endsWith('/rbac/presets')) data = []
    else if (name.includes('/__fixture__/failure')) { status = 503; data = { title: 'private-canary' } }
    else if (name.includes('/__fixture__/network')) return route.abort('failed')
    else if (name.includes('/planning/tasks')) data = { processes: [{ id: 801, project_id: 800, owner_id: 701, title: 'Fixture process', project_code: 'FIX', start_date: '2026-11-01', end_date: '2026-12-31', tasks: [{ id: 802, process_id: 801, owner_id: 701, title: 'Fixture task', start_date: '2026-11-01', end_date: '2026-12-31', color: '#1e8b78', resources: [], subtasks: [] }], milestones: [] }] }
    else if (name.includes('/planning/')) data = { projects: [] }
    else if (name.endsWith('/project')) data = { projects: [], total: 0 }
    else if (name.endsWith('/resources')) data = { resources: [], total: 0 }
    else if (name.includes('/user') || name.includes('/states')) data = []
    await route.fulfill({ status, contentType: 'application/json', headers: { 'x-request-id': 'a'.repeat(32) },
      body: JSON.stringify({ data, error: status >= 400 ? { code: status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR', message: 'private-canary' } : {} }) })
  })
  await context.exposeBinding('diagnosticCspViolation', (_, directive) => violations.push(directive))
  await context.addInitScript(() => {
    localStorage.setItem('mvs_erp_auto_sync', '0')
    localStorage.setItem('mvs_erp_ui_language', 'ru')
    document.addEventListener('securitypolicyviolation', event => void window.diagnosticCspViolation(event.effectiveDirective))
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const response = await page.goto(base + '/login')
  expect(response.headers()['content-security-policy']).toBe(webPolicy)
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click()
  await expect(page.locator('[role=dialog]')).toBeVisible()
  await expect.poll(() => page.locator('#web-diagnostic-report').inputValue()).toContain('1.6.0')
  await page.getByRole('button', { name: 'Закрыть', exact: true }).first().click()
  await page.locator('input[autocomplete=username]').fill('fixture')
  await page.locator('input[autocomplete=current-password]').fill('private-canary')
  await page.locator('button[type=submit]').click()
  await expect(page.locator('.ah-burger')).toBeVisible()
  await page.evaluate(async () => {
    const source = await (await fetch('/src/http.ts')).text()
    const module = source.match(/from\s*["']([^"']*axios[^"']*)["']/)
    if (!module) throw new Error('Axios fixture module was not resolved')
    window.fixtureAxios = (await import(module[1])).default
    window.fixtureDiagnostics = await import('/src/diagnostics/web.ts')
  })
  await page.evaluate(async () => {
    await window.fixtureAxios.get('/api/v1/__fixture__/failure?name=private-canary').catch(() => {})
    await window.fixtureAxios.get('/api/v1/__fixture__/network?name=private-canary').catch(() => {})
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    // A real unhandled rejection reaches the installed browser hook.
    void Promise.reject(new Error('intentional-private-canary'))
  })
  await expect.poll(() => page.evaluate(() => window.fixtureDiagnostics.webDiagnostics.snapshot().records.map(item => item.kind))).toContain('promise')
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click()
  const report = JSON.parse(await page.locator('#web-diagnostic-report').inputValue())
  expect(report.records.map(item => item.failure)).toEqual(expect.arrayContaining(['server_error', 'network_or_cors', 'chunk', 'promise']))
  expect(report.records.find(item => item.failure === 'server_error').diagnostic.request_id).toBe('a'.repeat(32))
  expect(JSON.stringify(report)).not.toContain('private-canary')
  expect(JSON.stringify(report)).not.toContain('Canary')
  await page.setViewportSize({ width: 390, height: 844 })
  const bounds = await page.locator('.wd-card').boundingBox()
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.width).toBeLessThanOrEqual(390)
  if (process.env.DIAGNOSTICS_SCREENSHOT) await page.screenshot({ path: process.env.DIAGNOSTICS_SCREENSHOT })
  await page.getByRole('button', { name: 'Скопировать отчёт' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('server_error')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 1000 })
  const sibling = await context.newPage()
  await sibling.goto(base + '/projects')
  await expect(sibling.locator('.ah-burger')).toBeVisible()
  expect(await sibling.evaluate(async () => (await import('/src/diagnostics/web.ts')).webDiagnostics.snapshot().records)).toEqual([])
  // Existing router navigation and Gantt remain independent of a reporting service.
  for (const tab of [page, sibling]) {
    await tab.evaluate(async () => {
      const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router
      await router.push('/processes'); await router.push('/planner')
    })
    await expect(tab).toHaveURL(/\/planner$/)
    await expect(tab.locator('.tg-scroll')).toBeVisible()
  }
  // Exercise the real capture/PDF implementation under the unchanged web CSP.
  const pdf = await page.evaluate(async () => {
    const { freezeDiagram, snapshotPdf } = await import('/src/components/planner/PdfExport/snapshot.ts')
    const source = document.querySelector('.tg-scroll')
    const result = await snapshotPdf(freezeDiagram(source, true), { extent: 'selection', cancelled: () => false, scope: 'tasks', groups: [{ id: 801, title: 'Fixture process', rows: [{ id: 802, title: 'Fixture task' }] }], showMilestones: true, showTodayLine: true, showResources: true, style: 'color', barThickness: 20 }, 'fixture')
    return { bytes: result.bytes.length, pages: result.pages.length }
  })
  expect(pdf.bytes).toBeGreaterThan(100); expect(pdf.pages).toBeGreaterThan(0)
  // A handled capture failure must appear in diagnostics, then a normal retry works.
  await page.evaluate(() => { document.querySelector('.tg-scroll').style.display = 'none' })
  await page.keyboard.press('Control+s')
  await expect(page.locator('.pe-msg-error')).toBeVisible()
  expect(await page.evaluate(() => window.fixtureDiagnostics.webDiagnostics.snapshot().records.some(item => item.kind === 'pdf'))).toBe(true)
  await page.locator('.pe-close').click()
  await page.evaluate(() => { document.querySelector('.tg-scroll').style.display = '' })
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.locator('.pe-pages canvas').count(), { timeout: 45000 }).toBeGreaterThan(0)
  const output = mkdtempSync(path.join(tmpdir(), 'clockwork-o08-pdf-'))
  try {
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.pe-btn-download').click()])
    const destination = path.join(output, 'fixture.pdf')
    await download.saveAs(destination)
    expect((await PDFDocument.load(readFileSync(destination))).getPageCount()).toBeGreaterThan(0)
  } finally { rmSync(output, { recursive: true, force: true }) }
  await page.keyboard.press('Control+p')
  await expect.poll(() => page.locator('.pe-pages canvas').count(), { timeout: 45000 }).toBeGreaterThan(0)
  // Only the OS dialog is stubbed: real iframe construction/image decoding still run.
  await page.evaluate(() => {
    window.printCalls = 0
    const original = document.createElement.bind(document)
    document.createElement = function(tag, ...args) {
      const element = original(tag, ...args)
      if (tag === 'iframe') queueMicrotask(() => {
        if (element.contentWindow) element.contentWindow.print = () => {
          window.printCalls++
          element.contentWindow.dispatchEvent(new Event('afterprint'))
        }
      })
      return element
    }
  })
  await page.locator('.pe-btn-primary').click()
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1)
  await expect(page.locator('.pe-modal')).toHaveCount(0)
  await context.setOffline(true)
  await page.evaluate(async () => { await window.fixtureAxios.get('/api/v1/__fixture__/offline').catch(() => {}); window.fixtureDiagnostics.openDiagnostics() })
  await expect(page.locator('[role=dialog]')).toBeVisible()
  expect(await page.evaluate(() => window.fixtureDiagnostics.webDiagnostics.snapshot().records.some(item => item.failure === 'network_or_cors'))).toBe(true)
  await page.keyboard.press('Escape')
  await context.setOffline(false)
  await page.evaluate(async () => { await window.fixtureAxios.get('/api/v1/health') })
  expect(await page.evaluate(async () => (await import('/src/offline/state.ts')).isOffline.value)).toBe(false)
  await page.evaluate(() => window.fixtureDiagnostics.openDiagnostics())
  await expect(page.locator('[role=dialog]')).toBeVisible()
  await sibling.evaluate(async () => (await import('/src/sessionSync.ts')).advanceSessionEpoch())
  await expect(page.locator('[role=dialog]')).toHaveCount(0)
  expect(await page.evaluate(() => window.fixtureDiagnostics.webDiagnostics.snapshot().records)).toEqual([])
  expect(foreign).toEqual([]); expect(violations).toEqual([])
  expect(errors.filter(error => error !== 'intentional-private-canary')).toEqual([])
  expect(requests.some(p => /telemetry|diagnostic|report/.test(p))).toBe(false)
  console.log('PASS web diagnostics: login/manual report, actual HTTP errors and request ID, promise/chunk hooks, two isolated tabs, navigation/Gantt/PDF/print/shortcuts, handled PDF error/retry, offline/recovery and cross-tab epoch reset; unchanged CSP and no upload')
} finally {
  await browser?.close()
  await server.close()
}
