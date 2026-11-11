import { request, expect, chromium } from 'playwright/test'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')] }))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'built-in-roles-' + Date.now(), dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const projects = [], users = []
let checks = 0
async function call(token, method, path, data) {
  path = path.replace(/^resource([/?]|$)/, 'resources$1')
  for (let i = 0; i < 5; i++) {
    const r = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (r.status() === 429) { await new Promise(resolve => setTimeout(resolve, Math.max(1, Number(r.headers()['retry-after']) || 1) * 1000)); continue }
    const text = await r.text(), body = text ? JSON.parse(text) : {}
    return { status: r.status(), data: body.data, error: body.error }
  }
  throw new Error('API rate limit persisted')
}
function check(actual, expected, name) { expect(actual, name).toEqual(expected); checks++ }
const sorted = ids => ids.sort((a, b) => a - b)
await expect.poll(async () => { try { return (await http.get('health')).status() } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
const login = await call(null, 'POST', 'auth/login', { username: 'admin', password: env.ADMIN_PASSWORD })
check(login.status, 200, 'admin login')
const admin = login.data.access_token, foreign = login.data.user.id
async function create(path, data, token = admin) {
  const r = await call(token, 'POST', path, data)
  check(r.status, 201, path + ' create: ' + JSON.stringify(r.error))
  return r.data.id
}
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
  const username='viewui'+Date.now().toString().slice(-8)
  const permissions=[{resource:'project',action:'view',scope:'all',granted:true},...['process','task','milestone','assignment'].map(resource=>({resource,action:'view',scope:'',granted:false}))]
  const u=await call(admin,'POST','user',{username,first_name:'UI',last_name:'Inheritance',preset:'worker',permissions})
  check(u.status,201,'UI subject');users.push(u.data.user.id)
  await page.addInitScript(()=>localStorage.setItem('mvs_erp_auto_sync','0'))
  await page.goto('http://127.0.0.1:5173/login');await page.locator('input[autocomplete=username]').fill('admin');await page.locator('input[autocomplete=current-password]').fill(env.ADMIN_PASSWORD);await page.locator('button[type=submit]').click();await expect(page).not.toHaveURL(/\/login/)
  await page.goto('http://127.0.0.1:5173/permissions')
  await page.locator('.pm-preset-btn').filter({has:page.getByText('dp',{exact:true})}).click()
  const block=title=>page.locator('.pm-block').filter({has:page.getByText(title,{exact:true})})
  await expect(page.locator('[data-action-group="prioritize"]')).toHaveCount(1)
  await expect(block('Проекты').locator('[data-action-group="prioritize"] .pm-row-label')).toHaveText('Изменение приоритета')
  for(const title of ['Процессы','Задачи','Вехи','Назначения ресурсов']){
    const row=block(title).locator('[data-action-group="view"]')
    await expect(row.locator('.pm-chip')).toHaveCount(4)
    await expect(row.locator('.pm-chip.on')).toHaveText(['Все'])
    await row.locator('.pm-choice-tooltip').hover()
    await expect(page.locator('.tt-popup')).toContainText('Просмотр разрешён правами родительского проекта, процесса или задачи.')
    expect(await page.locator('.tt-popup .pm-inherited-tooltip').evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-line')
    expect(await page.locator('.tt-popup').textContent()).toContain('\n\n')
    expect(await row.locator('.pm-chip').first().evaluate(el=>getComputedStyle(el).cursor)).toBe('not-allowed')
    for(const button of await row.locator('button').all())await expect(button).toBeDisabled()
    await expect(block(title).locator('[data-action-group="manage"] .pm-chip.rev')).toBeEnabled()
  }
  await expect(page.locator('.pm-head').getByRole('button',{name:'Сбросить всё к дефолтам',exact:true})).toBeVisible()
  await block('Проекты').locator('[data-action-group=prioritize]').getByRole('button',{name:'Все',exact:true}).click()
  await expect(page.locator('.pm-savebar-actions button')).toHaveText(['Сохранить','Отменить'])
  await page.locator('.pm-savebar-actions').getByRole('button',{name:'Отменить',exact:true}).click()
  await expect(page.getByRole('button',{name:/По общему/})).toHaveCount(0)
  await expect(page.getByText('adminConfig.perm.action.prioritize',{exact:true})).toHaveCount(0)
  await page.screenshot({path:'/tmp/erp-inherited-presets.png',fullPage:true})
  await page.goto('http://127.0.0.1:5173/users/'+u.data.user.id+'/edit/access')
  await expect(page.locator('.uped')).toBeVisible()
  const card=title=>page.locator('.uped-res-card').filter({has:page.locator('.uped-res-title').filter({hasText:title})})
  const taskCard=card('Задачи')
  await expect(taskCard).toHaveCount(1)
  const taskView=taskCard.locator('.ur-row').filter({has:page.getByText('Просмотр',{exact:true})})
  for(const button of await taskView.locator('button').all())await expect(button).toBeDisabled()
  await expect(taskView.locator('.ur-chip.on')).toHaveText(['Все'])
  await taskView.locator('.ur-choice-tooltip').hover()
  await expect(page.locator('.tt-popup')).toContainText('Просмотр разрешён правами родительского проекта, процесса или задачи.')
  expect(await taskView.locator('.ur-chip').first().evaluate(el=>getComputedStyle(el).cursor)).toBe('not-allowed')
  const create=taskCard.locator('.ur-row').filter({has:page.getByText('Управление',{exact:true})})
  await expect(create.locator('button').first()).toBeEnabled()
  await expect(page.locator('.ur-cap').filter({hasText:'Изменение приоритета'})).toHaveCount(1)
  await expect(page.getByRole('button',{name:/По общему/})).toHaveCount(0)
  await page.getByRole('button',{name:'Переключить язык',exact:true}).dispatchEvent('click')
  await expect(page.locator('.ur-cap').filter({hasText:'Change priority'})).toHaveCount(1)
  check(errors,[],'no browser errors')
  console.log('PASS live UI: translated project-only priority, four task choices, inherited all overrides child denials, ineffective denial disabled in preset and individual editors, management remains editable, no peer choices, RU/EN')
}finally{
  await browser.close()
  for(const id of users)await call(admin,'DELETE','user/'+id)
  await http.dispose()
}
