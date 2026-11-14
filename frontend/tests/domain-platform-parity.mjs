import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright/test'
import { launchElectronFixture } from './helpers/electron.mjs'

const base = process.env.ERP_TEST_URL || 'http://127.0.0.1:5173'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'A local source-level Vite server is required')
assert.ok(process.env.ELECTRON_EXECUTABLE, 'Set ELECTRON_EXECUTABLE to test a real isolated Electron process')
const cases = [
  ...['day', 'week'].flatMap(unit => ['2020-12-28', '2021-01-01', '2026-03-08', '2026-11-01'].map(date => ({ module: 'calendar', method: 'cellIndexForDate', args: ['2020-12-28', unit, date] }))),
  { module: 'planning', method: 'addResourceAssignment', args: [[{ id: 1, quantity: 2 }], { id: 1, quantity: 99 }] },
  { module: 'planning', method: 'removeResourceAssignment', args: [[{ id: 1, assignment_id: 2 }, { id: 3, assignment_id: 4 }], 2, 'assignment'] },
  { module: 'planning', method: 'taskDateRollback', args: [{ start_date: '2026-11-10', end_date: '2026-11-11' }, { start_date: '2026-11-09', end_date: '2026-11-11' }, { start_date: '2026-11-01', end_date: '2026-11-02' }] },
  ...['put', 'delete'].map(action => ({ module: 'timesheet', method: 'applyRangeSplit', args: [[{ id: 1, state_id: 2, start_date: '2026-11-01', end_date: '2026-11-30' }], action, '2026-11-10', '2026-11-12', null, { state_id: 3, is_available: false }] })),
  { module: 'periodAvailability', method: 'updatePeriodAvailability', args: [[{ resource_id: 1, periods: [{ start_date: '2026-11-01', end_date: '2026-11-30', capacity: 10, available: 10, unavailable: 0 }] }], 1, [], [{ state_id: 2, is_available: false, start_date: '2026-11-10', end_date: '2026-11-12' }], '2026-11-10', '2026-11-12'] },
]
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
let native
try {
  native = await launchElectronFixture()
  const web = await browser.newPage(), requests = []
  web.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()) })
  await web.route('**/__domain_fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
  await web.goto(base + '/__domain_fixture')
  const webResult = await web.evaluate(async cases => {
    const modules = { calendar: await import('/src/domain/calendar.ts'), planning: await import('/src/domain/planning.ts'), timesheet: await import('/src/domain/timesheet.ts'), periodAvailability: await import('/src/domain/periodAvailability.ts') }
    return JSON.parse(JSON.stringify(cases.map(test => modules[test.module][test.method](...test.args))))
  }, cases)
  const mainResult = await native.app.evaluate((_electron, { directory, cases }) => {
    const nativeRequire = process.getBuiltinModule('module').createRequire(directory + '/package.json')
    return JSON.parse(JSON.stringify(cases.map(test => nativeRequire('./command-' + test.module + '.cjs')[test.method](...test.args))))
  }, { directory: fileURLToPath(new URL('../desktop', import.meta.url)), cases })
  assert.deepEqual(mainResult, webResult, 'Electron main CJS transforms must agree with renderer TypeScript')
  assert.deepEqual(requests, [], 'Domain calculations must not request API data')
  console.log(`PASS ${cases.length} browser TypeScript/Electron main CJS parity cases; no API requests; isolated Electron profile`)
} finally {
  try { if (native) await native.close() } finally { await browser.close() }
}
