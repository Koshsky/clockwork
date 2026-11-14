import { chromium, expect } from 'playwright/test'
import { randomUUID } from 'node:crypto'
import { launchElectronFixture } from './helpers/electron.mjs'
const web = process.env.ERP_TEST_URL, api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !web || !api || [web, api].some(url => !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))) throw new Error('An isolated loopback test stack is required')
const native = process.env.ERP_TEST_DESKTOP === '1' ? await launchElectronFixture() : null
const browser = native ? null : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const page = native ? await native.app.firstWindow() : await browser.newPage()
const prefix = 'ports' + randomUUID().slice(0, 8), errors = []
page.on('pageerror', error => errors.push(error.message))
let access, project, account
async function call(method, path, body) {
 const result = await fetch(api + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: 'Bearer ' + access } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
 if (!result.ok) throw new Error(method + ' ' + path + ': ' + result.status)
 return result.status === 204 ? null : (await result.json()).data
}
try {
 const login = await call('POST', '/auth/login', { username: 'admin', password }); access = login.access_token
 const owner_id = login.user.id, dates = { start_date: '2026-11-01', end_date: '2026-11-30' }
 project = await call('POST', '/project', { code: prefix, owner_id, ...dates })
 const process = await call('POST', '/process', { project_id: project.id, title: prefix, owner_id, ...dates })
 const task = await call('POST', '/task', { process_id: process.id, title: prefix, owner_id, ...dates })
 await page.addInitScript(() => localStorage.setItem('mvs_erp_auto_sync', '0'))
 await page.goto(web + '/login')
 await page.locator('input[autocomplete=username]').fill('admin')
 await page.locator('input[autocomplete=current-password]').fill(password)
 await page.locator('button[type=submit]').click(); await expect(page).not.toHaveURL(/\/login/)
 await page.waitForLoadState('networkidle')
 const reads = await page.evaluate(async () => {
  const { applicationServices: services } = await import('/src/store/data/applicationClients.ts')
  const store = await import('/src/store/index.ts')
  const profile = await services.users.profile(store.useAuthStore().user.id)
  const structure = await services.users.structure()
  const presets = await services.rbac.presets(), matrix = await services.rbac.matrix()
  const config = await services.template.get()
  return { profile: profile.data.data.id, structure: Array.isArray(structure.data.data), presets: presets.status, matrix: matrix.status, config: config.status }
 })
 expect(reads).toMatchObject({ profile: owner_id, structure: true, presets: 200, matrix: 200, config: 200 })
 console.log('PASS shared profile, company structure, RBAC and template reads')
 account = await page.evaluate(async prefix => {
  const { applicationServices: services } = await import('/src/store/data/applicationClients.ts')
  const created = await services.users.create({ username: prefix, first_name: 'First', last_name: 'Last', preset: 'worker' })
  return created.data.data.user.id
 }, prefix)
 await page.evaluate(async ({ account, owner_id, prefix }) => {
  const { applicationServices: services } = await import('/src/store/data/applicationClients.ts')
  await services.users.update(account, { middle_name: 'Middle' })
  await services.users.setManager(account, { manager_id: owner_id })
  await services.users.setManager(account, {})
  await services.rbac.createPreset({ tag: prefix, name: 'Temporary preset' })
  await services.rbac.updatePreset(prefix, { name: 'Renamed preset' })
  await services.rbac.removePreset(prefix)
  await services.rbac.saveUser(account, { overrides: [{ resource: 'project', action: 'view', scope: 'all', granted: true }] })
 }, { account, owner_id, prefix })
 const saved = await call('GET', '/user/accounts/' + account)
 expect(saved.middle_name).toBe('Middle'); expect(saved.manager_id ?? 0).toBe(0)
 console.log('PASS account edits, clearing manager and permission preset commands')
 const oneTime = await page.evaluate(async account => (await import('/src/store/data/uiServices.ts')).applicationData.session.resetPassword(account), account)
 expect(oneTime.status).toBe('confirmed'); expect(oneTime.data.password).toBeTruthy()
 const resetLogin = await call('POST', '/auth/login', { username: prefix, password: oneTime.data.password })
 expect(resetLogin.user.id).toBe(account)
 console.log('PASS online-only password reset returns its one-time result')
 const comment = await page.evaluate(async ({ taskId, prefix }) => {
  const { applicationServices: services } = await import('/src/store/data/applicationClients.ts')
  const created = await services.tasks.createComment(taskId, { content: prefix })
  const listed = await services.tasks.comments(taskId)
  return { id: created.data.data.id, found: listed.data.data.some(row => row.content === prefix) }
 }, { taskId: task.id, prefix })
 expect(comment.found).toBe(true)
 await page.evaluate(async ({ taskId, commentId }) => (await import('/src/store/data/applicationClients.ts')).applicationServices.tasks.removeComment(taskId, commentId), { taskId: task.id, commentId: comment.id })
 expect(await call('GET', '/task/' + task.id + '/comments')).toEqual([])
 console.log('PASS comment create, read and delete retain the common task workspace contract')
 if (native) {
  const before = await native.app.evaluate(async () => (await globalThis.commandQueueFixture.control({ action: 'list', after: 0 })).items.length)
  expect(before).toBe(0)
  await native.app.evaluate(async () => { await globalThis.syncFixture.stop(); await globalThis.sessionFixture.enterOffline('admin') })
  const result = await page.evaluate(async ({ account, taskId }) => {
   const { applicationServices: services } = await import('/src/store/data/applicationClients.ts')
   const { applicationData } = await import('/src/store/data/uiServices.ts')
   const outcomes = []
   for (const action of [() => services.users.update(account, { first_name: 'Not queued' }), () => services.tasks.createComment(taskId, { content: 'Not queued' })]) {
    try { await action(); outcomes.push('accepted') } catch { outcomes.push('rejected') }
   }
   const reset = await applicationData.session.resetPassword(account)
   return { outcomes, reset: reset.status, offlineCommands: applicationData.capabilities.offlineCommands }
  }, { account, taskId: task.id })
  expect(result.outcomes).toEqual(['rejected', 'rejected']); expect(result.reset).toBe('rejected')
  expect(result.offlineCommands.some(name => /^(account|comment|rbac|template)\./.test(name))).toBe(false)
  expect(await native.app.evaluate(async () => (await globalThis.commandQueueFixture.control({ action: 'list', after: 0 })).items.length)).toBe(before)
  console.log('PASS offline administration, comments and secrets are rejected without growing the queue')
 }
 expect(errors).toEqual([])
} finally {
 if (native) await native.close(); else await browser.close()
 if (account) await call('DELETE', '/user/' + account)
 if (project) await call('DELETE', '/project/' + project.id)
}
