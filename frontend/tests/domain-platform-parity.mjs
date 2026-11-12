import assert from 'node:assert/strict'
import { chromium } from 'playwright/test'
import { launchElectronFixture } from './helpers/electron.mjs'

const base = process.env.ERP_TEST_URL || 'http://127.0.0.1:5173'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'A local source-level Vite server is required')
assert.ok(process.env.ELECTRON_EXECUTABLE, 'Set ELECTRON_EXECUTABLE to test a real isolated Electron process')
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
let native
try {
  native = await launchElectronFixture()
  const web = await browser.newPage()
  const desktop = await native.app.firstWindow()
  async function evaluate(page, electron) {
    const apiRequests = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
    })
    await page.route('**/__domain_fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
    await page.goto(base + '/__domain_fixture')
    const result = await page.evaluate(async () => {
      const { allResourceScenarioTraces } = await import('/tests/fixtures/planningDomain.ts')
      return { electron: window.erpDesktop?.isElectron === true, traces: allResourceScenarioTraces() }
    })
    assert.equal(result.electron, electron)
    assert.deepEqual(apiRequests, [], 'Domain calculations must not request API data')
    return result.traces
  }
  const webResult = await evaluate(web, false)
  const desktopResult = await evaluate(desktop, true)
  for (const unit of ['day', 'week']) {
    for (let scenario = 1; scenario <= 9; scenario++) {
      assert.deepEqual(webResult[unit][scenario], desktopResult[unit][scenario], `${unit}: scenario ${scenario}`)
      console.log(`PASS ${unit}: resource scenario ${scenario}, identical browser/Electron results`)
    }
  }
  console.log('PASS 18 platform-parity cases; no API requests; isolated Electron profile')
} finally {
  try { if (native) await native.close() } finally { await browser.close() }
}
