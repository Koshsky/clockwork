import fs from 'node:fs'
import { chromium, expect, request } from 'playwright/test'

const web = process.env.ERP_TEST_URL ?? 'http://localhost:5173'
const api = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
for (const url of [web, api]) if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Resource-header fixtures require loopback URLs')
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const i = line.indexOf('=')
  return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')]
}))
const password = process.env.RBAC_TEST_ADMIN_PASSWORD ?? env.ADMIN_PASSWORD
const prefix = 'rh' + Date.now()
const http = await request.newContext({ baseURL: api + '/' })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true })
let token
const projects = [], users = [], resources = [], requests = [], errors = []
async function call(method, path, data) {
  for (let n = 0; n < 10; n++) {
    const reply = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (reply.status() === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    const expected = method === 'DELETE' ? 204 : method === 'POST' && path !== 'auth/login' ? 201 : 200
    expect(reply.status(), method + ' ' + path).toBe(expected)
    return expected === 204 ? null : (await reply.json()).data
  }
  throw new Error('Resource-header fixture rate limit')
}
async function open(username, secret) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(origin => {
    if (location.origin !== origin) return
    localStorage.setItem('mvs_erp_auto_sync', '0')
    localStorage.setItem('mvs_erp_ui_lang', 'ru')
  }, new URL(web).origin)
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  context.on('request', req => {
    const url = new URL(req.url())
    if (url.pathname === '/api/v1/resources') requests.push({ username, owner: url.searchParams.get('owner_id'), limit: url.searchParams.get('limit'), subject: req.headers()['x-view-user-id'] })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  await page.goto(web + '/login')
  await page.locator('input[autocomplete=username]').fill(username)
  await page.locator('input[autocomplete=current-password]').fill(secret)
  await page.locator('button[type=submit]').click()
  await expect(page).not.toHaveURL(/\/login/)
  await page.goto(web + '/planner')
  await expect(page.locator('.ah-burger')).toBeVisible()
  return { context, page }
}
async function navigate(page, path) {
  const nav = page.locator('.nd')
  if (!/nd--open/.test(await nav.getAttribute('class'))) await page.locator('.ah-burger').click()
  const link = nav.locator('a[href="' + path + '"]')
  if (!await link.isVisible()) await link.locator('xpath=ancestor::section').locator('.nd-group-head').click()
  await link.click()
  await expect(page).toHaveURL(new RegExp(path + '$'))
}
async function header(page, expected) {
  await expect.poll(async () => (await page.locator('.rs-code').allTextContents()).filter(code => code.startsWith(prefix)).sort(), { timeout: 20000 }).toEqual([...expected].sort())
}
try {
  token = (await call('POST', 'auth/login', { username: 'admin', password })).access_token
  for (const suffix of ['a', 'b']) users.push(await call('POST', 'user', { username: prefix + suffix, first_name: 'Header', last_name: 'Fixture', preset: 'vp' }))
  const dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
  users.push(await call('POST', 'user', { username: prefix + 'empty', first_name: 'No resources', last_name: 'Fixture', preset: 'vp' }))
  for (let i = 0; i < 2; i++) {
    const owner = users[i].user.id
    const project = await call('POST', 'project', { ...dates, code: prefix + '-project-' + i, owner_id: owner })
    projects.push(project)
    const process = await call('POST', 'process', { ...dates, title: prefix + '-process-' + i, project_id: project.id, owner_id: owner })
    await call('POST', 'task', { ...dates, title: prefix + '-task-' + i, process_id: process.id, owner_id: owner })
    resources.push(await call('POST', 'resources', { code: prefix + '-' + i, title: prefix + '-resource-' + i, owner_id: owner }))
  }
  const admin = await open('admin', password)
  const codes = resources.map(row => row.code)
  await header(admin.page, codes)
  expect(requests.some(req => req.username === 'admin' && req.limit === '500' && req.owner == null && !req.subject)).toBe(true)
  await expect(admin.page.locator('.pp-toolbar select option[value=""]')).toHaveText('Все ресурсы')
  console.log('PASS administrator: both owners and unassigned resources are visible; catalogue request omits owner_id')

  await navigate(admin.page, '/projects')
  await expect(admin.page).toHaveURL(/\/projects$/)
  await navigate(admin.page, '/planner')
  await header(admin.page, codes)
  await admin.page.reload()
  await header(admin.page, codes)
  // Reload resets the module registry, so visit both routes before disconnecting.
  await navigate(admin.page, '/projects')
  await navigate(admin.page, '/planner')
  await admin.context.setOffline(true)
  await navigate(admin.page, '/projects')
  await navigate(admin.page, '/planner')
  await header(admin.page, codes)
  await admin.context.setOffline(false)
  console.log('PASS administrator: complete header survives navigation, reload and warmed offline navigation')

  const selector = admin.page.locator('.pp-toolbar select')
  await expect(selector.locator('option[value="' + users[0].user.id + '"]')).toHaveCount(1, { timeout: 20000 })
  await expect(selector.locator('option[value="' + users[1].user.id + '"]')).toHaveCount(1)
  await expect(selector.locator('option[value="' + users[2].user.id + '"]')).toHaveCount(0)
  const catalogue = []
  for (let offset = 0; ; offset += 500) {
    const rows = (await call('GET', 'resources?limit=500&offset=' + offset)).items
    catalogue.push(...rows)
    if (rows.length < 500) break
  }
  const ownerIds = [...new Set(catalogue.map(row => String(row.owner_id)))].sort()
  const optionIds = await selector.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean).sort())
  expect(optionIds).toEqual(ownerIds)
  for (const [owner, expected] of [[users[0].user.id, [codes[0]]], [users[1].user.id, [codes[1]]], ['', codes]]) {
    await selector.selectOption(String(owner))
    await header(admin.page, expected)
    await expect(admin.page.locator('body')).toContainText(prefix + '-task-0')
    await expect(admin.page.locator('body')).toContainText(prefix + '-task-1')
    await expect(admin.page.locator('body')).toContainText(prefix + '-process-0')
    await expect(admin.page.locator('body')).toContainText(prefix + '-process-1')
    await expect(admin.page.locator('body')).toContainText(prefix + '-project-0')
    await expect(admin.page.locator('body')).toContainText(prefix + '-project-1')
    expect(await admin.page.locator('.gb-handle').count()).toBeGreaterThan(0)
  }
  expect(requests.filter(req => req.username === 'admin').every(req => !req.subject && req.owner == null)).toBe(true)
  console.log('PASS resource-only filter: owners with resources only; all projects/processes/tasks and editing handles stay available; no impersonation requests')

  const employee = await open(users[0].user.username, users[0].password)
  await header(employee.page, [codes[0]])
  await expect(employee.page.locator('.pp-toolbar select')).toHaveCount(0)
  expect(requests.some(req => req.username === users[0].user.username && req.owner === String(users[0].user.id) && !req.subject)).toBe(true)
  expect(errors).toEqual([])
  console.log('PASS non-admin: only owned resources, no administrator selector and no browser errors')
} finally {
  await browser.close()
  for (const project of projects) await call('DELETE', 'project/' + project.id)
  for (const resource of resources) await call('DELETE', 'resources/' + resource.id)
  for (const user of users) await call('DELETE', 'user/' + user.user.id)
  await http.dispose()
}
