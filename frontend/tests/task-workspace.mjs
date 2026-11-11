import { chromium, expect, request } from 'playwright/test'
import { mkdir } from 'node:fs/promises'

const apiURL = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
const webURL = process.env.RBAC_TEST_WEB_URL ?? 'http://127.0.0.1:5173'
for (const value of [apiURL, webURL]) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw new Error('Task workspace fixtures require loopback URLs')
}
if (!process.env.RBAC_TEST_ADMIN_PASSWORD) throw new Error('Set RBAC_TEST_ADMIN_PASSWORD for the local administrator')
const http = await request.newContext({ baseURL: apiURL.replace(/\/?$/, '/') })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage(), cleanup = [], errors = []
page.on('pageerror', (error) => errors.push(error.message))
const prefix = `workspace${Date.now()}`, dates = { start_date: '2026-11-10', end_date: '2026-11-20' }
let admin, checks = 0
async function call(method, path, data) {
  for (let retry = 0; retry < 8; retry++) {
    const response = await http.fetch(path, { method, data, headers: admin ? { Authorization: `Bearer ${admin}` } : {} })
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    const body = await response.text()
    return { status: response.status(), ...(body ? JSON.parse(body) : {}) }
  }
  throw new Error('Persistent API rate limit')
}
async function create(path, data) {
  const response = await call('POST', path, data)
  expect(response.status, `create ${path}`).toBe(201)
  const undo = () => call('DELETE', `${path}/${response.data.id}`)
  if (path === 'resources') cleanup.unshift(undo)
  else cleanup.push(undo)
  return response.data.id
}
async function section(name) { await page.locator('.te-nav').getByRole('button', { name: new RegExp(`^${name}`) }).click() }
async function menu(bar, name) {
  await bar.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: 650, clientY: 400 })
  await page.getByRole('menuitem', { name, exact: true }).click()
}
async function scrollState() { return page.locator('.tg-scroll').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop })) }
try {
  const login = await call('POST', 'auth/login', { username: 'admin', password: process.env.RBAC_TEST_ADMIN_PASSWORD })
  expect(login.status).toBe(200)
  admin = login.data.access_token
  const owner_id = login.data.user.id
  const project = await create('project', { ...dates, code: prefix, owner_id })
  const processId = await create('process', { ...dates, owner_id, project_id: project, title: `${prefix} process` })
  const task = await create('task', { ...dates, owner_id, process_id: processId, title: `${prefix} task` })
  await create('task', { ...dates, owner_id, process_id: processId, parent_id: task, title: `${prefix} subtask` })
  await create('task', { ...dates, owner_id, process_id: processId, title: `${prefix} predecessor` })
  const resource = await create('resources', { code: prefix, title: `${prefix} resource`, owner_id })
  await page.addInitScript(() => localStorage.setItem('mvs_erp_auto_sync', '0'))
  await page.goto(`${webURL}/login`)
  await page.locator('input[autocomplete=username]').fill('admin')
  await page.locator('input[autocomplete=current-password]').fill(process.env.RBAC_TEST_ADMIN_PASSWORD)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await page.goto(`${webURL}/planner?process=${processId}`)
  const bar = () => page.locator('.gantt-bar').filter({ hasText: `${prefix} task` }).first()
  await expect(bar()).toBeVisible()
  const before = await scrollState()
  await page.locator('.tg-scroll').evaluate(el => el.setAttribute('data-workspace-fixture', 'retained'))
  await menu(bar(), 'Редактировать')
  await expect(page.locator('[role=dialog]')).toHaveCount(1)
  await page.waitForLoadState('networkidle')
  await new Promise(resolve => setTimeout(resolve, 1500))
  console.log('Task workspace: opened with real planning data')
  const title = page.locator('.te-left input')
  await title.fill(`${prefix} task changed`)
  await section('Подзадачи')
  await expect(page.locator('.te-item-title').filter({ hasText: `${prefix} subtask` })).toBeVisible()
  await section('Зависимости')
  await expect(page.locator('.te-dep-add select').first().locator('option').filter({ hasText: `${prefix} predecessor` })).toHaveCount(1)
  await section('Ресурсы')
  await page.locator('.rm-select').selectOption(String(resource))
  await page.locator('.rm-qty').fill('2')
  const assignmentResponse = page.waitForResponse(response => response.url().endsWith('/assignment') && response.request().method() === 'POST')
  await page.locator('.rm-btn').click()
  expect((await assignmentResponse).status(), 'assignment confirmed by backend').toBe(201)
  await expect(page.locator('.mf-close')).toBeEnabled()
  await expect(page.locator('.rm-item').filter({ hasText: `${prefix} resource` })).toBeVisible()
  await section('Основное')
  await expect(title).toHaveValue(`${prefix} task changed`)
  checks++
  await section('Обсуждение')
  const draft = page.locator('.tc-composer textarea')
  await expect(draft).toBeEnabled()
  await draft.fill(`${prefix} draft`)
  await section('Ресурсы')
  await page.locator('.mf-close').click()
  await expect(page.locator('.te-confirm')).toBeVisible()
  await page.getByRole('button', { name: 'Продолжить редактирование' }).click()
  await section('Обсуждение')
  await expect(draft).toHaveValue(`${prefix} draft`)
  await page.locator('.tc-composer .tc-send').click()
  await expect(draft).toHaveValue('')
  await expect(page.locator('.tc-item').filter({ hasText: `${prefix} draft` })).toBeVisible()
  checks++
  // A nested delete confirmation must own Escape, leaving the task card open.
  await page.locator('.tc-del').first().click()
  await expect(page.locator('.cd')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.cd')).toHaveCount(0)
  await expect(page.locator('.te-workspace')).toBeVisible()
  await expect(page.locator('.te-confirm')).toHaveCount(0)
  checks++
  const taskURL = `**/api/v1/task/${task}`
  await page.route(taskURL, async route => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: 'Test conflict' } }) })
    else await route.continue()
  })
  await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
  await expect(page.locator('.te-footer [role=alert]')).toBeVisible()
  await section('Основное')
  await expect(title).toHaveValue(`${prefix} task changed`)
  await page.unroute(taskURL)
  await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click()
  await expect(page.locator('.te-footer [role=alert]')).toHaveCount(0)
  await expect.poll(async () => (await call('GET', `task/${task}`)).data.title).toBe(`${prefix} task changed`)
  const beforeClose = await scrollState()
  await page.locator('.te-footer .te-cancel').click()
  await expect(page.locator('.te-workspace')).toHaveCount(0)
  expect((await scrollState()).left).toEqual(before.left)
  expect(await scrollState()).toEqual(beforeClose)
  await expect(page.locator('.tg-scroll')).toHaveAttribute('data-workspace-fixture', 'retained')
  checks++
  await menu(bar(), 'Управление ресурсами')
  await expect(page.locator('.te-nav [aria-current]')).toHaveText(/Ресурсы/)
  await expect(page.locator('.rm-item')).toContainText(`${prefix} resource`)
  await page.locator('.rm-remove').click()
  await expect(page.locator('.rm-item')).toHaveCount(0)
  await expect(page.locator('.mf-close')).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.locator('.te-workspace')).toHaveCount(0)
  await menu(bar(), 'Комментарии')
  await expect(page.locator('.te-nav [aria-current]')).toHaveText(/Обсуждение/)
  await expect(page.locator('.tc-item')).toContainText(`${prefix} draft`)
  checks++
  console.log('Task workspace: mutations, retries and direct sections passed')
  // Long lists share the content scroller, keeping navigation and footer visible.
  await page.evaluate(() => {
    const list = document.querySelector('.tc-list'), item = list.querySelector('.tc-item')
    for (let i = 0; i < 50; i++) list.append(item.cloneNode(true))
  })
  await mkdir('/tmp/erp-task-workspace', { recursive: true })
  for (const scheme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-scheme', value), scheme)
    for (const width of [1440, 736, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const box = await page.locator('.te-workspace').boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      expect(box.y + box.height).toBeLessThanOrEqual(900)
      expect(await page.locator('.te-workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      expect(await page.locator('.te-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await expect(page.locator('.te-footer .te-cancel')).toBeInViewport()
      await expect(page.locator('.tc-composer textarea')).toBeInViewport()
      await page.screenshot({ path: `/tmp/erp-task-workspace/${scheme}-${width}.png` })
      checks++
    }
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.te-workspace')).toHaveCount(0)
  expect(errors).toEqual([])
  console.log(`PASS task workspace: ${checks} checks; real backend save, conflict/retry, resource add/remove, comment, direct sections, drafts, nested Escape, Gantt position and responsive layouts`)
} finally {
  await browser.close()
  for (const undo of cleanup.reverse()) {
    try {
      const result = await undo()
      if (![200, 204, 404].includes(result.status)) console.error(`Fixture cleanup failed: ${result.status}`)
    } catch { console.error('Fixture cleanup failed') }
  }
  await http.dispose()
}
