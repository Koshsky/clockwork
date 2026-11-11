import { chromium, expect } from 'playwright/test'

const webURL = process.env.NAV_TEST_WEB_URL ?? 'http://localhost:5173'
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(webURL).hostname)) throw new Error('Navigation fixtures require a loopback URL')
const password = process.env.NAV_TEST_PASSWORD ?? process.env.RBAC_TEST_ADMIN_PASSWORD
if (!password) throw new Error('Set NAV_TEST_PASSWORD or RBAC_TEST_ADMIN_PASSWORD')
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addInitScript((origin) => {
  if (location.origin === origin) localStorage.setItem('mvs_erp_auto_sync', '0')
}, new URL(webURL).origin)
const page = await context.newPage()
const errors = []
let refreshes = 0, transitions = 0
context.on('request', request => { if (new URL(request.url()).pathname.endsWith('/auth/refresh')) refreshes++ })
context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)))
page.on('pageerror', error => errors.push(error.message))
const paths = ['/projects', '/processes', '/timesheet', '/users', '/structure', '/permissions', '/planner']
const warmTimes = []
async function clickLink(tab, path, mobile = false) {
  const nav = tab.locator('.nd')
  if (!/nd--open/.test(await nav.getAttribute('class'))) await tab.locator('.ah-burger').click()
  const link = nav.locator(`a[href="${path}"]`)
  if (!await link.isVisible()) await link.locator('xpath=ancestor::section').locator('.nd-group-head').click()
  await link.click()
  await expect(tab).toHaveURL(new RegExp(`${path}$`))
  await expect(link).toHaveClass(/active/)
  if (mobile) await expect(nav).not.toHaveClass(/nd--open/)
  transitions++
}
try {
  await page.goto(`${webURL}/login`)
  await page.locator('input[autocomplete=username]').fill(process.env.NAV_TEST_USERNAME ?? 'admin')
  await page.locator('input[autocomplete=current-password]').fill(password)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  // A restored session first observes an empty access-token slot, then receives a valid token.
  const beforeReload = refreshes
  await page.reload()
  await expect(page.locator('.ah-burger')).toBeVisible()
  expect(refreshes - beforeReload, 'one refresh restores the document session').toBe(1)
  const restored = refreshes
  for (const path of paths) await clickLink(page, path)
  expect(refreshes, 'desktop menu must reuse its valid restored token').toBe(restored)
  for (const path of paths) {
    const started = performance.now()
    await clickLink(page, path)
    warmTimes.push(Math.round(performance.now() - started))
  }
  // Two tabs share the rotating refresh token; a valid session must not enter the lock wait on each click.
  const sibling = await context.newPage()
  await sibling.goto(`${webURL}/projects`)
  await expect(sibling.locator('.ah-burger')).toBeVisible()
  const twoTabs = refreshes
  for (const path of ['/processes', '/timesheet', '/structure']) await clickLink(sibling, path)
  for (const path of ['/projects', '/permissions', '/planner']) await clickLink(page, path)
  expect(refreshes, 'switching pages in two restored tabs must not rotate valid sessions').toBe(twoTabs)
  await sibling.close()
  if (/nd--open/.test(await page.locator('.nd').getAttribute('class'))) await page.locator('.ah-burger').click()
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of paths) await clickLink(page, path, true)
  expect(refreshes, 'mobile navigation must not refresh a valid token').toBe(twoTabs)
  await page.goBack()
  await expect(page).toHaveURL(/\/permissions$/)
  await page.goForward()
  await expect(page).toHaveURL(/\/planner$/)
  expect(refreshes, 'history navigation must reuse the session').toBe(twoTabs)
  expect(errors, 'no browser runtime errors').toEqual([])
  console.log(`PASS navigation: ${transitions} real menu clicks plus back/forward, restored sessions, two tabs and mobile; zero extra refreshes; warm transitions ${warmTimes.join('/')} ms`)
} finally { await browser.close() }
