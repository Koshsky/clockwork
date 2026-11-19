// Real Electron IPC and renderer, isolated source fixture; no application backend or packaged build.
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { expect } from 'playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { rendererBuildComposition } from '../scripts/build-targets.mjs'
import { readVersion } from '../scripts/app-version.cjs'
import { launchElectronFixture } from './helpers/electron.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const { desktopPolicy, securityHeaders } = createRequire(import.meta.url)('../desktop/security.cjs')
const server = await createServer({ root, configFile: false, cacheDir: path.join(root, 'node_modules/.vite-o09-diagnostics'),
  plugins: [vue(), rendererBuildComposition('desktop', readVersion())], resolve: { alias: { '@': path.join(root, 'src') } },
  define: { __APP_VERSION__: JSON.stringify(readVersion()), 'import.meta.env.VITE_API_URL': JSON.stringify('/api/v1') },
  server: { host: '127.0.0.1', port: 0, hmr: false, headers: securityHeaders(desktopPolicy) } })
let fixture
try {
  await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  process.env.ERP_TEST_URL = base
  fixture = await launchElectronFixture()
  const app = fixture.app, page = await app.firstWindow()
  const violations = [], errors = [], foreign = []
  app.context().on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('data:')) foreign.push(request.url()) })
  await app.context().exposeBinding('diagnosticCspViolation', (_, value) => violations.push(value))
  await app.context().addInitScript(() => {
    localStorage.setItem('mvs_erp_ui_lang', 'en')
    document.addEventListener('securitypolicyviolation', event => void window.diagnosticCspViolation(event.effectiveDirective))
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/login')
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeVisible()
  await app.evaluate(() => {
    globalThis.diagnosticJournalFixture.record('main', 'diagnostic', { response: { status: 403, data: { error: { code: 'FORBIDDEN', message: 'private-canary' } } }, config: { headers: { Authorization: 'private-canary' } } }, {}, 'failed')
  })
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Diagnostics' })
  await expect(dialog.getByRole('button', { name: 'Save bundle' })).toBeEnabled()
  const preview = await dialog.locator('textarea').inputValue()
  expect(preview).not.toContain('private-canary'); expect(JSON.parse(preview).state.queue).toBeNull()
  expect(JSON.parse(preview).records.some(row => row.diagnostic.status === 403)).toBe(true)
  await dialog.getByRole('button', { name: 'Save bundle' }).click()
  await expect(dialog.getByText('Diagnostic bundle saved.')).toBeVisible()
  const destination = await app.evaluate(() => globalThis.diagnosticReportPath)
  expect(readFileSync(destination, 'utf8')).toBe(preview)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()
  const otherWindow = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, options) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    globalThis.attachSessionFixture(win.webContents); void win.loadURL(options.url)
  }, { preload: path.join(root, 'desktop/preload.js'), url: base + '/login' })
  const other = await otherWindow
  await other.getByRole('button', { name: 'Diagnostics', exact: true }).click()
  await expect(other.getByRole('dialog', { name: 'Diagnostics' }).locator('textarea')).toHaveValue(preview)
  await app.evaluate(() => globalThis.sessionFixture.selectServer('http://127.0.0.1:9/api/v1'))
  await expect(other.getByRole('dialog', { name: 'Diagnostics' })).toBeHidden()
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click()
  await expect(dialog.locator('textarea')).not.toHaveValue(preview)
  expect((await dialog.locator('textarea').inputValue())).not.toContain('FORBIDDEN')
  expect(violations).toEqual([]); expect(errors).toEqual([]); expect(foreign).toEqual([])
  console.log('Native diagnostics: real macOS Electron, CSP, two windows, private preview/exact save and server boundary passed; no backend traffic.')
} finally { if (fixture) await fixture.close(); await server.close() }
