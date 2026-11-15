import { createServer } from 'vite'
import { chromium, expect } from 'playwright/test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { webPolicy } = require('../desktop/security.cjs')
const root = fileURLToPath(new URL('..', import.meta.url))
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-branding-ui-'))
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  let custom = true
  const name = 'Company <img src=x onerror=alert(1)>'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64')
  const errors = [], dialogs = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
  await page.route('**/api/v1/**', route => route.fulfill({ status: route.request().url().includes('/auth/') ? 401 : 200, json: { data: null, error: {} } }))
  await page.route('**/assets/custom/branding/config.json', route => route.fulfill({ status: custom ? 200 : 404, json: custom ? { name, primaryColor: '#7841AF', logo: 'logo.png' } : {} }))
  await page.route('**/assets/custom/branding/logo.png', route => route.fulfill({ contentType: 'image/png', body: png }))
  await page.route('**/login', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': webPolicy } })
  })
  await page.goto(`http://127.0.0.1:${address.port}/login`)
  await expect(page.locator('.lp-btitle')).toHaveText(name)
  await expect(page).toHaveTitle(name)
  await expect(page.locator('.lp-brand-image')).toBeVisible()
  expect(await page.locator('.lp-brand-image').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
  await expect(page.locator('.lp-btitle img')).toHaveCount(0)
  expect(await page.locator('link[rel=icon]').getAttribute('href')).toMatch(/^data:image\/png/)
  const rasterTypes = await page.evaluate(async () => {
    const { normalizeBranding } = await import('/src/domain/branding.ts')
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
    return ['image/jpeg', 'image/webp'].map(type => normalizeBranding({ logo: canvas.toDataURL(type) }).logo?.startsWith(`data:${type};`) ?? false)
  })
  expect(rasterTypes).toEqual([true, true])
  await page.evaluate(async () => { const { setAppLocale } = await import('/src/i18n/index.ts'); setAppLocale('en'); setAppLocale('ru') })
  await expect(page).toHaveTitle(name)
  const color = await page.locator('.lp-btitle').evaluate(node => getComputedStyle(node).color)
  expect(color).not.toBe('rgb(26, 115, 232)')
  await page.evaluate(async () => {
    const { createApp } = await import('/node_modules/.vite/deps/vue.js')
    const { createRouter, createMemoryHistory } = await import('/node_modules/.vite/deps/vue-router.js')
    const { default: Drawer } = await import('/src/components/common/AppNavDrawer/AppNavDrawer.vue')
    const host = document.createElement('div'); document.body.append(host)
    const router = createRouter({ history: createMemoryHistory(), routes: [] })
    createApp(Drawer, { open: true, categories: [] }).use(router).mount(host)
  })
  await expect(page.locator('.nd-brand')).toHaveText(name)
  await expect(page.locator('.nd-brand img')).toHaveCount(0)
  await expect(page.locator('.nd-brand-image')).toBeVisible()
  expect(dialogs).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({ path: path.join(output, 'custom.png') })
  const pdf = await page.evaluate(async () => {
    const { createApp, nextTick } = await import('/node_modules/.vite/deps/vue.js')
    const { default: Planning } = await import('/src/components/planner/TaskPlanning/TaskPlanning.vue')
    const { freezeDiagram, snapshotCanvas, snapshotPdf } = await import('/src/components/planner/PdfExport/snapshot.ts')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:300px;top:20px;width:1000px;--planner-max-height:340px'
    document.body.append(host)
    const tasks = [1, 2].map(id => ({ id, title: 'Task ' + id, color: '#c55070', start_date: '2026-11-09', end_date: '2026-11-19' }))
    const app = createApp(Planning, { processes: [{ id: 1, title: 'Process', start_date: '2026-11-01', end_date: '2026-11-30', tasks }], origin: '2026-11-01', focusDate: '2026-11-09', unit: 'day', canManage: false })
    app.mount(host); await nextTick(); await new Promise(resolve => setTimeout(resolve, 100))
    const source = host.querySelector('.tg-scroll')
    const bars = source.querySelectorAll('.gantt-bar')
    // Opaque fixture bars isolate palette fidelity from row/background blending.
    for (const bar of bars) bar.style.opacity = '1'
    bars[0].style.backgroundColor = 'var(--ui-accent)'
    source.scrollLeft += bars[0].getBoundingClientRect().left - source.getBoundingClientRect().left - 340
    source.dispatchEvent(new Event('scroll'))
    await new Promise(resolve => setTimeout(resolve, 200))
    const accent = getComputedStyle(bars[0]).backgroundColor
    const snapshot = freezeDiagram(source)
    const options = { groups: [{ id: 1, title: 'Process', rows: tasks }], scope: 'tasks', showMilestones: true, showTodayLine: true, showResources: true, style: 'color', barThickness: snapshot.barThickness }
    try {
      const canvas = await snapshotCanvas(snapshot, options, 1)
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      const colors = [accent, 'rgb(197, 80, 112)'].map(color => color.match(/\d+/g).map(Number))
      const counts = colors.map(rgb => {
        let count = 0
        for (let i = 0; i < pixels.length; i += 4) if (rgb.every((value, channel) => pixels[i + channel] === value)) count++
        return count
      })
      const result = await snapshotPdf(snapshot, options, 'Company planning')
      return { counts, colors, accent, png: canvas.toDataURL('image/png'), pages: result.pages.length, bytes: result.bytes.length }
    } finally { snapshot.dispose(); app.unmount(); host.remove() }
  })
  await fs.writeFile(path.join(output, 'diagram.png'), Buffer.from(pdf.png.split(',')[1], 'base64'))
  expect(pdf.counts.every(count => count > 50), JSON.stringify({ counts: pdf.counts, colors: pdf.colors, output })).toBe(true)
  expect(pdf.pages).toBe(1)
  expect(pdf.bytes).toBeGreaterThan(1000)
  custom = false
  await page.reload()
  await expect(page.locator('.lp-btitle')).toHaveText('Clockwork')
  await expect(page.locator('.lp-brand-image')).toHaveCount(0)
  await expect(page).toHaveTitle('Clockwork')
  expect(await page.locator('.lp-btitle').evaluate(node => getComputedStyle(node).color)).toBe('rgb(26, 115, 232)')
  await page.screenshot({ path: path.join(output, 'clockwork.png') })
  console.log('PASS: login, drawer, logo, favicon, custom/default colors, inert company text and Gantt PDF colors under enforced CSP; screenshots ' + output)
} finally {
  await browser?.close()
  await server.close()
}
