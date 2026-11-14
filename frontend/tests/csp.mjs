import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect } from 'playwright/test'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { PDFDocument } from 'pdf-lib'
import { launchElectronFixture } from './helpers/electron.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const { webPolicy, desktopPolicy, securityHeaders } = createRequire(import.meta.url)('../desktop/security.cjs')
const password = process.env.ERP_TEST_PASSWORD
const api = process.env.ERP_TEST_API
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !api || !['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('CSP fixtures require an explicit isolated loopback API and password')
const output = process.env.ERP_TEST_OUTPUT || '/tmp/erp-csp-tests'
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const foreign = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(req.url === '/evil.js' ? 'window.foreignScriptRan=true' : 'foreign')
})
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve))
const foreignURL = `http://127.0.0.1:${foreign.address().port}`
const profiles = process.env.CSP_PROFILE ? [process.env.CSP_PROFILE] : ['web', 'desktop']

async function checkFeatures(server, profile) {
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  process.env.ERP_TEST_URL = base
  if (profile === 'desktop' && !process.env.ELECTRON_EXECUTABLE) throw new Error('Set ELECTRON_EXECUTABLE for the real desktop CSP acceptance')
  const native = profile === 'desktop' ? await launchElectronFixture() : null
  console.log(`Checking ${profile} CSP in ${native ? 'native Electron' : 'Chromium'}`)
  const context = native ? native.app.context() : await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const violations = [], errors = []
  try {
    await context.exposeBinding('reportCspViolation', (_, value) => violations.push(value))
    await context.addInitScript(() => {
      localStorage.setItem('mvs_erp_auto_sync', '0')
      document.addEventListener('securitypolicyviolation', event => void window.reportCspViolation({ directive: event.effectiveDirective, blocked: event.blockedURI }))
    })
    const page = native ? await native.app.firstWindow() : await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    const response = await page.goto(base + '/login')
    expect(response.headers()['content-security-policy']).toBe(profile === 'desktop' ? desktopPolicy : webPolicy)
    await page.locator('input[autocomplete=username]').fill('admin')
    await page.locator('input[autocomplete=current-password]').fill(password)
    await page.locator('button[type=submit]').click()
    await expect(page).not.toHaveURL(/\/login/)
    await page.waitForLoadState('networkidle')
    await page.evaluate(async () => (await import('/src/platform/current.ts')).currentRuntime.value?.stop())
    if (native) {
      await native.app.evaluate(async () => { await globalThis.syncFixture.stop(); await globalThis.sessionFixture.enterOffline('admin') })
      await expect.poll(() => page.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().sessionMode)).toBe('offline')
    }
    // Seed only client state: PDF checks must not create production-like records.
    await page.evaluate(async desktop => {
      const store = await import('/src/store/index.ts'), offline = await import('/src/offline/state.ts')
      window.cspMutation = (await import('/src/offline/mutationGuard.ts')).beginMutation()
      offline.isOffline.value = true
      const app = store.useAppStore(), planning = store.usePlanningStore(), auth = store.useAuthStore(), rbac = store.useRbacStore()
      const userId = auth.user.id
      if (!window.erpDesktop?.session) auth.user = { ...auth.user, preset: 'vp' }
      rbac.permsLoaded = true
      rbac.myPermissions = ['project', 'process', 'task', 'resource', 'assignment'].map(resource => ({ resource, action: 'view', scope: 'all' }))
      app.users = [{ id: userId, name: 'CSP Test', first_name: 'Test', last_name: 'CSP' }]
      app.myStaff = app.users
      app.resources = [{ id: 90001, owner_id: userId, code: 'CSP', title: 'CSP resource', employees_count: 3 }]
      if (window.erpDesktop?.queue?.mainSync) {
        const contextId = (await window.erpDesktop.session.status()).contextId
        for (const owner of ['all', String(userId)]) await window.erpDesktop.queue.request({ action: 'cachePut', key: '/local/resource-header?owner_id=' + owner, value: { ts: Date.now(), data: JSON.parse(JSON.stringify(app.resources)) }, contextId })
      }
      app.calendar = [{ resource_id: 90001, periods: [{ start_date: '2026-01-01', end_date: '2027-12-31', available: 3 }] }]
      const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
      planning.taskPlanning = { processes: [{ id: 90002, owner_id: userId, project_id: 90003, project_owner_id: userId, project_code: 'CSP', title: 'CSP process', ...dates,
        tasks: [{ id: 90004, owner_id: userId, responsible_id: userId, process_id: 90002, title: 'CSP PDF task', color: '#1e8b78', ...dates, resources: [{ id: 90001, assignment_id: 90005, code: 'CSP', quantity: 2 }], subtasks: [{ id: 90006, title: 'CSP subtask', status: 'done' }] }], milestones: [] }] }
      planning.projectPlanning = { projects: [{ id: 90003, owner_id: userId, project_code: 'CSP', ...dates }] }
      planning.processPlanning = { projects: [{ id: 90003, owner_id: userId, project_code: 'CSP', ...dates, processes: planning.taskPlanning.processes }] }
      const settings = await import('/src/settings.ts')
      for (const key of ['badgeTaskProjectCode', 'badgeTaskOwner', 'badgeTaskResponsible', 'badgeTaskResources', 'badgeTaskSubtasks']) settings.viewSettings[key] = true
      const config = await import('/src/config.ts')
      if (desktop && !config.getApiUrl().startsWith('http://127.0.0.1:')) throw new Error('Desktop cross-origin backend was not selected')
      const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router
      await router.push('/planner?process=90002')
    }, profile === 'desktop')
    await expect(page.locator('.gantt-bar').filter({ hasText: 'CSP PDF task' })).toBeVisible()
    // The local worker fallback stays usable without allowing blob workers.
    expect(await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker('/__csp__/worker.js', { type: 'module' })
      worker.onmessage = event => { worker.terminate(); resolve(event.data) }
      worker.onerror = reject
    }))).toBe('ready')
    for (const unit of ['day', 'week']) {
      await page.evaluate(unit => {
        let vm = document.querySelector('.tg-scroll').__vueParentComponent
        while (vm && vm.type.__name !== 'PlannerPage') vm = vm.parent
        vm.setupState.unit = unit
      }, unit)
      await page.keyboard.press('Control+s')
      await expect(page.locator('.pe-modal')).toHaveCount(1)
      await expect.poll(() => page.locator('.pe-pages canvas').count(), { timeout: 45000 }).toBeGreaterThan(0)
      await expect(page.locator('.pe-updating')).toHaveCount(0)
      await expect(page.locator('.pe-msg-error')).toHaveCount(0)
      await page.screenshot({ path: `${output}/${profile}-${unit}.png` })
      const filename = `${output}/${profile}-${unit}.pdf`
      if (native) {
        const count = await native.app.evaluate(() => globalThis.cspDownloads.length)
        await page.locator('.pe-btn-download').click()
        await expect.poll(() => native.app.evaluate(() => globalThis.cspDownloads.length), { timeout: 30000 }).toBe(count + 1)
        const download = await native.app.evaluate(() => globalThis.cspDownloads.at(-1))
        expect(download.state).toBe('completed')
        copyFileSync(download.path, filename)
      } else {
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.pe-btn-download').click()])
        await download.saveAs(filename)
      }
      const pdf = await PDFDocument.load(readFileSync(filename))
      expect(pdf.getPageCount()).toBeGreaterThan(0)
      await page.keyboard.press('Control+p')
      await expect.poll(() => page.locator('.pe-pages canvas').count(), { timeout: 45000 }).toBeGreaterThan(0)
      await expect(page.locator('.pe-updating')).toHaveCount(0)
      // Intercept only the OS print dialog; image decoding and iframe CSS run unchanged.
      await page.evaluate(() => {
        window.printCalls = 0
        const create = document.createElement.bind(document)
        document.createElement = function(tag, ...args) {
          const element = create(tag, ...args)
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
      console.log(`PASS ${profile}: ${unit} PDF preview/download, Ctrl+S/Ctrl+P and print iframe`)
    }
    expect(errors, `${profile} runtime errors`).toEqual([])
    expect(violations, `${profile} legitimate operations must not violate CSP`).toEqual([])
    // Attack probes are separate from the legitimate-operation violation count.
    await page.evaluate(async foreignURL => {
      window.inlineRan = false
      const script = document.createElement('script')
      script.textContent = 'window.inlineRan=true'
      document.head.append(script)
      const external = document.createElement('script')
      external.src = foreignURL + '/evil.js'
      const settled = new Promise(resolve => { external.onerror = resolve; external.onload = resolve })
      document.head.append(external)
      await settled
      const injected = async src => {
        const element = document.createElement('script')
        element.src = src
        const ready = new Promise(resolve => { element.onerror = resolve; element.onload = resolve })
        document.head.append(element)
        await ready
      }
      await injected('data:text/javascript,window.dataScriptRan=true')
      const blob = URL.createObjectURL(new Blob(['window.blobScriptRan=true'], { type: 'text/javascript' }))
      await injected(blob)
      URL.revokeObjectURL(blob)
      await injected('/__csp__/eval.js')
      window.runCspEval()
      const button = document.createElement('button')
      button.setAttribute('onclick', 'window.attributeRan=true')
      document.body.append(button)
      button.click()
      const object = document.createElement('object')
      object.data = 'data:text/html,<p>blocked</p>'
      document.body.append(object)
      const frame = document.createElement('iframe')
      frame.src = foreignURL + '/frame'
      document.body.append(frame)
      const base = document.createElement('base')
      base.href = foreignURL + '/'
      document.head.append(base)
      window.foreignFetch = await fetch(foreignURL + '/data').then(() => true, () => false)
    }, foreignURL)
    expect(await page.evaluate(() => window.inlineRan || window.foreignScriptRan === true || window.dataScriptRan === true || window.blobScriptRan === true || window.attributeRan === true || window.evalRan === true)).toBe(false)
    expect(await page.evaluate(() => window.evalBlocked)).toBe(true)
    await expect.poll(() => violations.some(v => v.directive === 'script-src-attr')).toBe(true)
    await expect.poll(() => violations.some(v => v.directive === 'object-src')).toBe(true)
    await expect.poll(() => violations.some(v => v.directive === 'frame-src')).toBe(true)
    expect(await page.evaluate(() => document.baseURI)).toBe(base + '/planner?process=90002')
    expect(await page.evaluate(() => window.foreignFetch)).toBe(false)
    await expect.poll(() => violations.some(v => v.directive === 'script-src-elem' && v.blocked === 'inline')).toBe(true)
    expect(violations.some(v => v.directive === 'base-uri')).toBe(true)
    expect(violations.some(v => v.directive === 'connect-src')).toBe(true)
    console.log(`PASS ${profile}: inline/foreign scripts and base injection blocked; network scope enforced`)
  } finally { if (native) await native.close(); else await context.close() }
}

try {
  for (const profile of profiles) {
    if (!['web', 'desktop'].includes(profile)) throw new Error('Unknown CSP profile')
    const cacheName = `.vite-csp-${profile}`
    const server = await createServer({
      configFile: false, root, plugins: [vue(), {
        name: 'csp-test-fixtures',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const fixtures = {
              '/precache-manifest.json': ['application/json', '{"version":"1.6.1","assets":[]}'],
              '/__csp__/worker.js': ['text/javascript', "postMessage('ready')"],
              '/__csp__/eval.js': ['text/javascript', "window.runCspEval=()=>{try{new Function('window.evalRan=true')()}catch(error){window.evalBlocked=error.name==='EvalError'}}"],
            }
            const item = fixtures[req.url]
            if (!item) return next()
            for (const [name, value] of Object.entries(securityHeaders(profile === 'desktop' ? desktopPolicy : webPolicy))) res.setHeader(name, value)
            res.setHeader('Content-Type', item[0]); res.end(item[1])
          })
        },
      }],
      cacheDir: process.env.ERP_TEST_CACHE_DIR ? path.join(process.env.ERP_TEST_CACHE_DIR, cacheName) : `node_modules/${cacheName}`,
      resolve: { alias: { '@': path.join(root, 'src') } },
      define: { __APP_VERSION__: JSON.stringify('1.6.1'), 'import.meta.env.VITE_API_URL': JSON.stringify(profile === 'desktop' ? api + '/api/v1' : '/api/v1') },
      server: { host: '127.0.0.1', port: Number(process.env.ERP_TEST_SECURITY_PORT || 0), strictPort: Boolean(process.env.ERP_TEST_SECURITY_PORT), hmr: false, headers: securityHeaders(profile === 'desktop' ? desktopPolicy : webPolicy), proxy: { '/api': { target: api, changeOrigin: true } } },
    })
    try {
      await server.listen()
      await checkFeatures(server, profile)
      if (process.env.CSP_SKIP_P0 !== '1') {
        await new Promise((resolve, reject) => {
          const suite = profile === 'desktop' ? 'desktop-command-delivery' : 'web-api-commands'
          const child = spawn(process.execPath, [`tests/${suite}.mjs`], { cwd: root, stdio: 'inherit', env: { ...process.env, ERP_TEST_URL: server.resolvedUrls.local[0].replace(/\/$/, ''), ERP_TEST_CSP: '1', RBAC_TEST_API_URL: api + '/api/v1', RBAC_TEST_WEB_URL: server.resolvedUrls.local[0].replace(/\/$/, ''), RBAC_TEST_ADMIN_PASSWORD: password, ERP_TEST_DESKTOP: profile === 'desktop' ? '1' : '0', ERP_TEST_AXIOS_PATH: `/node_modules/${cacheName}/deps/axios.js` } })
          child.on('error', reject)
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${profile} offline P0 suite failed: ${code}`)))
        })
      }
    } finally { await server.close() }
  }
} finally {
  await browser.close()
  await new Promise(resolve => foreign.close(resolve))
}
