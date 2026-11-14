import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect, request } from 'playwright/test'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { launchElectronFixture } from './helpers/electron.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { webPolicy, desktopPolicy, securityHeaders } = createRequire(import.meta.url)('../desktop/security.cjs')
const backend = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !backend || !password || !['localhost', '127.0.0.1'].includes(new URL(backend).hostname)) throw new Error('XSS fixtures require an explicit isolated loopback API and password')
const output = process.env.ERP_TEST_OUTPUT || '/tmp/erp-xss-tests'
mkdirSync(output, { recursive: true })
const http = await request.newContext({ baseURL: backend + '/api/v1/' })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const cleanup = [], userCleanup = [], resourceCleanup = [], prefix = `XSS${Date.now()}`
const trigger = 'top.__storedXss=1;fetch(`/__xss__/beacon`)'
const svgBypass = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;${trigger}&lt;/script&gt;"></iframe></foreignObject></svg>`
const payloads = [
  `<img data-xss="img" src=x onerror="${trigger}">`,
  `<svg data-xss="svg" onload="${trigger}"></svg>`,
  `</div><script data-xss="script">${trigger}</script><div>`,
  `"><img data-xss="attr" src=x onerror="${trigger}">`,
  `&lt;img data-xss="entity" src=x onerror="${trigger}"&gt;`,
  `[link](<java\tscript:top.__storedXss=1>)`,
]
const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
let admin, author, reader, authorToken
async function api(token, method, url, data) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const response = await http.fetch(url, { method, data, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    const text = await response.text()
    return { status: response.status(), ...(text ? JSON.parse(text) : {}) }
  }
  throw new Error('API rate limit did not recover')
}
async function create(token, kind, body) {
  const result = await api(token, 'POST', kind, body)
  expect(result.status, `create ${kind}`).toBe(201)
  const undo = () => api(admin, 'DELETE', `${kind}/${result.data.id}`)
  if (kind === 'resources') resourceCleanup.push(undo)
  else cleanup.push(undo)
  return result.data.id
}
async function provision(username, preset, name) {
  const result = await api(admin, 'POST', 'user', { username, preset, first_name: name, last_name: 'XSS' })
  expect(result.status).toBe(201)
  userCleanup.push(() => api(admin, 'DELETE', `user/${result.data.user.id}`))
  return { id: result.data.user.id, username, password: result.data.password }
}
async function safeDOM(page, label) {
  expect(await page.evaluate(() => window.__storedXss || 0), label + ': no executed payload').toBe(0)
  expect(await page.locator('[data-xss], [onerror], [onload], foreignObject, iframe[srcdoc], object').count(), label + ': no attacker elements').toBe(0)
  const unsafeLinks = await page.locator('a[href]').evaluateAll(links => links.filter(link => ['javascript:', 'data:', 'vbscript:'].includes(link.protocol)).map(link => link.getAttribute('href')))
  expect(unsafeLinks, label + ': no executable links').toEqual([])
}
async function navigate(page, url) {
  await page.evaluate(url => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(url), url)
}
async function runtime(page) {
  await page.evaluate(async () => {
    const store = await import('/src/store/index.ts')
    window.xssRuntime = { store, planning: store.usePlanningStore(), app: store.useAppStore(), router: document.querySelector('#app').__vue_app__.config.globalProperties.$router }
  })
}
const rows = []
try {
  const login = await api(null, 'POST', 'auth/login', { username: 'admin', password })
  expect(login.status).toBe(200)
  admin = login.data.access_token
  author = await provision(prefix + 'a', 'rp', payloads[0])
  reader = await provision(prefix + 'b', 'dp', 'Reader')
  const writable = ['project', 'process', 'task', 'resource', 'milestone', 'assignment'].flatMap(resource => ['view', 'create', 'update', 'delete'].map(action => ({ resource, action, scope: 'all', granted: true })))
  expect((await api(admin, 'PUT', `rbac/users/${author.id}/permissions`, { overrides: writable })).status).toBe(200)
  const readable = [...['project', 'process', 'task', 'resource', 'milestone', 'assignment', 'user_admin'].map(resource => ({ resource, action: 'view', scope: 'all', granted: true }))]
  expect((await api(admin, 'PUT', `rbac/users/${reader.id}/permissions`, { overrides: readable })).status).toBe(200)
  const aLogin = await api(null, 'POST', 'auth/login', { username: author.username, password: author.password })
  expect(aLogin.status).toBe(200)
  authorToken = aLogin.data.access_token
  expect(aLogin.data.user.id).not.toBe(reader.id)
  for (let i = 0; i < payloads.length; i++) {
    const value = `${prefix}-${i} ${payloads[i]}`
    const project = await create(authorToken, 'project', { ...dates, code: value, owner_id: author.id })
    const processId = await create(authorToken, 'process', { ...dates, project_id: project, owner_id: author.id, title: value })
    const task = await create(authorToken, 'task', { ...dates, process_id: processId, owner_id: author.id, responsible_id: author.id, title: value })
    const resource = await create(authorToken, 'resources', { code: `${prefix}-${i}`, title: value, owner_id: author.id })
    await create(authorToken, 'assignment', { task_id: task, resource_id: resource, quantity: 1 })
    const comment = await api(authorToken, 'POST', `task/${task}/comments`, { content: value })
    expect(comment.status).toBe(201)
    expect(comment.data.author_id).toBe(author.id)
    rows.push({ value, project, processId, task, resource, comment: comment.data.id })
  }
  for (const platform of (process.env.XSS_PLATFORM ? [process.env.XSS_PLATFORM] : ['web', 'desktop'])) for (const csp of (process.env.XSS_CSP ? [process.env.XSS_CSP] : ['off', 'on'])) {
    if (!['web', 'desktop'].includes(platform)) throw new Error('XSS_PLATFORM must be web or desktop')
    const policy = platform === 'desktop' ? desktopPolicy : webPolicy
    if (!['off', 'on'].includes(csp)) throw new Error('XSS_CSP must be on or off')
    let beacons = 0
    const violations = [], errors = []
    const server = await createServer({
      configFile: false, root, cacheDir: process.env.ERP_TEST_CACHE_DIR ? path.join(process.env.ERP_TEST_CACHE_DIR, `xss-${platform}-${csp}`) : `node_modules/.vite-xss-${platform}-${csp}`, plugins: [vue(), {
        name: 'xss-test-fixtures', configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/__xss__/beacon') { beacons++; res.end('unexpected'); return }
            if (req.url === '/__xss__/renderers') {
              res.setHeader('Content-Type', 'text/html')
              if (csp === 'on') for (const [key, value] of Object.entries(securityHeaders(policy))) res.setHeader(key, value)
              res.end('<!doctype html><html><head><title>XSS renderer fixture</title></head><body><div id="xss-renderer"></div><script type="module" src="/tests/fixtures/xss-renderers.ts"></script></body></html>')
              return
            }
            if (req.url?.startsWith('/assets/custom/icons/')) {
              res.setHeader('Content-Type', 'image/svg+xml'); res.end(svgBypass); return
            }
            if (req.url === '/precache-manifest.json') {
              res.setHeader('Content-Type', 'application/json'); res.end('{"version":"1.6.1","assets":[]}'); return
            }
            next()
          })
        },
      }], resolve: { alias: { '@': path.join(root, 'src') } }, define: { __APP_VERSION__: JSON.stringify('1.6.1'), 'import.meta.env.VITE_API_URL': JSON.stringify('/api/v1') },
      server: { host: '127.0.0.1', port: Number(process.env.ERP_TEST_SECURITY_PORT || 0), strictPort: Boolean(process.env.ERP_TEST_SECURITY_PORT), hmr: false, forwardConsole: false, headers: csp === 'on' ? securityHeaders(policy) : {}, proxy: { '/api': { target: backend, changeOrigin: true } } },
    })
    await server.listen()
    const base = server.resolvedUrls.local[0].replace(/\/$/, '')
    process.env.ERP_TEST_URL = base
    if (platform === 'desktop' && !process.env.ELECTRON_EXECUTABLE) throw new Error('Set ELECTRON_EXECUTABLE for the real desktop XSS acceptance')
    const native = platform === 'desktop' ? await launchElectronFixture() : null
    const context = native ? native.app.context() : await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    if (!native) await context.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Web cannot consume a legacy XSS cache') } }))
    await context.exposeBinding('recordXssCsp', (_, entry) => violations.push(entry))
    await context.addInitScript(() => {
      localStorage.setItem('mvs_erp_auto_sync', '0')
      window.__storedXss = 0
      document.addEventListener('securitypolicyviolation', event => void window.recordXssCsp({ directive: event.effectiveDirective, blocked: event.blockedURI }))
    })
    const page = native ? await native.app.firstWindow() : await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', async dialog => { errors.push('Unexpected native dialog: ' + dialog.type()); await dialog.dismiss() })
    try {
      const loginPage = await page.goto(base + '/login')
      expect(Boolean(loginPage.headers()['content-security-policy'])).toBe(csp === 'on')
      await page.locator('input[autocomplete=username]').fill(reader.username)
      await page.locator('input[autocomplete=current-password]').fill(reader.password)
      await page.locator('button[type=submit]').click()
      await expect(page).not.toHaveURL(/\/login/)
      await page.waitForLoadState('networkidle')
      await runtime(page)
      await page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
      await expect(page.locator('.nd svg').first()).toBeVisible()
      await safeDOM(page, 'custom SVG fallback in navigation')
      await page.getByRole('button', { name: 'Закрыть меню', exact: true }).click()
      expect(await page.evaluate(() => window.xssRuntime.store.useAuthStore().user.id)).toBe(reader.id)
      if (native) await page.evaluate(async () => window.erpDesktop.queue.request({ action: 'sync', force: true, pullOnly: true, contextId: (await window.erpDesktop.session.status()).contextId }))
      // User B reads the unmodified strings stored by user A through real APIs.
      const received = await page.evaluate(async ids => {
        const { applicationServices } = await import('/src/store/data/applicationClients.ts')
        return Promise.all(ids.map(id => applicationServices.tasks.comments(id).then(response => response.data.data)))
      }, rows.map(row => row.task))
      for (let i = 0; i < rows.length; i++) expect(received[i].find(comment => comment.id === rows[i].comment).content).toBe(rows[i].value)
      await navigate(page, '/resources')
      await page.evaluate(() => window.xssRuntime.app.refreshResources())
      for (const row of rows) await expect(page.locator('.dt-cell').filter({ hasText: row.value }).first()).toBeVisible()
      await safeDOM(page, 'resource table')
      await expect(page.locator('.dt-cell').filter({ hasText: payloads[0] }).first()).toBeVisible()
      await safeDOM(page, 'resource owner name')
      console.log(`PASS ${platform} CSP ${csp}: user A stored -> user B read tables, names and custom icon fallback`)
      for (const [url, kind] of [['/projects', 'Project'], ['/processes', 'Process'], ['/planner', 'Task']]) {
        await navigate(page, url)
        await page.evaluate(kind => window.xssRuntime.planning[`refresh${kind}Planning`](true), kind)
        for (const row of rows) await expect(page.locator('.tg-scroll').getByText(row.value, { exact: true }).first()).toBeAttached()
        await safeDOM(page, kind + ' Gantt')
      }
      for (const row of rows) {
        const bar = page.locator('.gantt-bar').filter({ has: page.locator('.tb-title').filter({ hasText: row.value }) }).first()
        await bar.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 700, clientY: 450 })
        await page.getByRole('menuitem', { name: 'Комментарии', exact: true }).click()
        await expect(page.locator('.tc-text').filter({ hasText: row.value })).toHaveText(row.value)
        await safeDOM(page, 'comment')
        await page.keyboard.press('Escape')
      }
      console.log(`PASS ${platform} CSP ${csp}: stored project/process/task names, assignment badges and comments remain text`)
      if (native) {
      // Force a fresh document and real cache reads, with every API request blocked.
      await native.app.evaluate(async () => { await globalThis.syncFixture.stop(); globalThis.sessionFetchOverride = async () => { throw new Error('Offline XSS fixture') }; await globalThis.sessionFixture.enterOffline() })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.ah-burger')).toBeVisible({ timeout: 15000 })
      await expect(page).not.toHaveURL(/\/login/)
      await runtime(page)
      await page.evaluate(async () => {
        (await import('/src/offline/state.ts')).isOffline.value = true
        await window.xssRuntime.planning.loadTaskPlanning()
      })
      for (const row of rows) {
        await expect(page.locator('.tg-scroll').getByText(row.value, { exact: true }).first()).toBeAttached()
        const bar = page.locator('.gantt-bar').filter({ has: page.locator('.tb-title').filter({ hasText: row.value }) }).first()
        await bar.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 700, clientY: 450 })
        await page.getByRole('menuitem', { name: 'Комментарии', exact: true }).click()
        await expect(page.locator('.tc-text').filter({ hasText: row.value })).toHaveText(row.value)
        await safeDOM(page, 'offline comment')
        await page.keyboard.press('Escape')
      }
      await navigate(page, '/resources')
      for (const row of rows) await expect(page.locator('.dt-cell').filter({ hasText: row.value }).first()).toBeVisible()
      await safeDOM(page, 'offline resource table')
      await navigate(page, '/planner')
      console.log(`PASS ${platform} CSP ${csp}: fresh document reopens persisted API/permission/comment caches without executing data`)
      } else console.log(`PASS web CSP ${csp}: legacy IndexedDB access denied throughout stored-XSS reads`)
      for (const unit of ['day', 'week']) {
        await page.evaluate(unit => {
          let vm = document.querySelector('.tg-scroll').__vueParentComponent
          while (vm && vm.type.__name !== 'PlannerPage') vm = vm.parent
          vm.setupState.unit = unit
        }, unit)
        await page.keyboard.press('Control+s')
        await expect(page.locator('.pe-modal')).toHaveCount(1)
        if (await page.locator('.pe-filter-label').count() === 0) await page.locator('.pe-filters-toggle').filter({ hasText: 'Процессы' }).click()
        for (const row of rows) {
          await page.locator('.pe-filter-item').filter({ has: page.getByText(row.value, { exact: true }) }).locator('input').check()
        }
        await expect.poll(() => page.locator('.pe-pages canvas').count(), { timeout: 45000 }).toBeGreaterThan(0)
        await expect(page.locator('.pe-updating')).toHaveCount(0)
        await safeDOM(page, 'PDF preview')
        const filename = `${output}/stored-${platform}-${csp}-${unit}.pdf`
        if (native) {
          const count = await native.app.evaluate(() => globalThis.cspDownloads.length)
          await page.locator('.pe-btn-download').click()
          await expect.poll(() => native.app.evaluate(() => globalThis.cspDownloads.length), { timeout: 30000 }).toBe(count + 1)
          const download = await native.app.evaluate(() => globalThis.cspDownloads.at(-1))
          expect(download.state).toBe('completed')
          const { copyFileSync } = await import('node:fs'); copyFileSync(download.path, filename)
        } else {
          const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.pe-btn-download').click()])
          await download.saveAs(filename)
        }
        const pdf = await PDFDocument.load(readFileSync(filename))
        expect(pdf.getPageCount()).toBeGreaterThan(0)
        for (const [, object] of pdf.context.enumerateIndirectObjects()) {
          const dictionary = object instanceof PDFDict ? object : object.dict
          if (!dictionary) continue
          for (const name of ['JS', 'JavaScript', 'AA', 'OpenAction']) expect(dictionary.get(PDFName.of(name))).toBeUndefined()
          expect(dictionary.get(PDFName.of('S'))?.toString()).not.toBe('/JavaScript')
        }
        await safeDOM(page, 'PDF download')
      }
      console.log(`PASS ${platform} CSP ${csp}: ${native ? 'offline ' : ''}day/week PDF preview and download with stored XSS strings`)
      // Hints/icons are deployment assets, not writable by ordinary API users.
      // Exercise the actual Markdown component with the hostile text read from B's API.
      await page.goto(base + '/__xss__/renderers')
      await expect.poll(() => page.evaluate(() => typeof window.setXssMarkdown)).toBe('function')
      for (const comments of received) {
        for (const comment of comments) {
          await page.evaluate(source => window.setXssMarkdown(source), comment.content)
          await safeDOM(page, 'Markdown renderer boundary')
        }
      }
      await page.evaluate(source => window.setXssMarkdown(source), '[safe](https://example.com)\n\n**bold**\n\n' + '[unsafe](<java\tscript:top.__storedXss=1>)')
      await expect(page.locator('.mdv a')).toHaveCount(1)
      await expect(page.locator('.mdv a')).toHaveAttribute('href', 'https://example.com')
      await expect(page.locator('.mdv strong')).toHaveText('bold')
      await safeDOM(page, 'Markdown URL regression')
      expect(beacons).toBe(0)
      expect(violations, 'escaping/sanitization must work before CSP gets involved').toEqual([])
      expect(errors).toEqual([])
      console.log(`PASS ${platform} CSP ${csp}: SVG/srcdoc and control-character URL bypasses rejected before CSP`)
    } finally { if (native) await native.close(); else await context.close(); await server.close() }
  }
} finally {
  await browser.close()
  const cleanupFailures = []
  for (const undo of [...cleanup.reverse(), ...resourceCleanup.reverse(), ...userCleanup.reverse()]) {
    const result = await undo()
    if (![200, 204, 404].includes(result.status)) cleanupFailures.push(result.status)
  }
  await http.dispose()
  if (cleanupFailures.length) throw new Error('Fixture cleanup failed: ' + cleanupFailures.join(', '))
}
