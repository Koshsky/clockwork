import { request, expect, chromium } from 'playwright/test'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')] }))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'user-access-' + Date.now(), dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
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
const errors=[];page.on('pageerror',error=>errors.push(error.message))
let user5Writes=0
page.on('request',req=>{if(/\/(user\/5|rbac\/users\/5\/permissions)$/.test(new URL(req.url()).pathname)&&['PUT','POST','DELETE'].includes(req.method()))user5Writes++})
const card=resource=>page.locator('.uped-res-card[data-resource="'+resource+'"]')
const row=(resource,group)=>card(resource).locator('[data-action-group="'+group+'"]')
const active=(resource,group)=>row(resource,group).locator('.ur-chip.on')
const choice=(resource,group,scope)=>row(resource,group).locator('button[data-scope="'+scope+'"]')
const signature=rules=>JSON.stringify(rules.map(r=>({resource:r.resource,action:r.action,granted:r.granted,scope:r.granted?r.scope:''})).sort((a,b)=>(a.resource+'/'+a.action).localeCompare(b.resource+'/'+b.action)))
const navigate=async id=>{
 await page.goto('http://127.0.0.1:5173/users/'+id+'/edit/access')
 await expect(card('task')).toBeVisible()
 await expect(page.locator('.uped-st:not(.er)')).toHaveCount(0)
}
try{
 const before5=await call(admin,'GET','rbac/users/5/permissions');check(before5.status,200,'snapshot real user 5')
 await page.addInitScript(()=>localStorage.setItem('mvs_erp_auto_sync','0'))
 await page.goto('http://127.0.0.1:5173/login')
 await page.locator('input[autocomplete=username]').fill('admin');await page.locator('input[autocomplete=current-password]').fill(env.ADMIN_PASSWORD);await page.locator('button[type=submit]').click();await expect(page).not.toHaveURL(/\/login/)
 await navigate(5)
 await expect(page.locator('.uped-column')).toHaveCount(2)
 await expect(page.locator('.uped-dirty')).toHaveCount(0)
 await expect(page.locator('.ua-actions')).toHaveCount(0)
 await expect(page.locator('.ur-cap').filter({hasText:/^(Создание|Изменение|Удаление)$/})).toHaveCount(0)
 await expect(page.locator('.uped button').filter({hasText:'⛔'})).toHaveCount(0)
 await expect(page.locator('.ur-cap').filter({hasText:'Изменение приоритета'})).toHaveCount(1)
 for(const width of [1440,1024,720,390,360]){
  await page.setViewportSize({width,height:1000})
  const expected=width>=1024?2:1
  await expect(page.locator('.uped-column')).toHaveCount(expected)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'fits '+width).toBe(true)
  if(expected===1)expect(await page.locator('.uped-res-card').evaluateAll(cards=>cards.map(c=>Number(c.dataset.order)))).toEqual(Array.from({length:15},(_,i)=>i))
 }
 await page.setViewportSize({width:1440,height:1000})
 await expect(page.locator('.uped-column')).toHaveCount(2)
 await page.screenshot({path:'/tmp/erp-user-access-final-light.png'})
 await page.getByRole('button',{name:'Переключить тему',exact:true}).click();await page.waitForTimeout(400)
 await page.screenshot({path:'/tmp/erp-user-access-final-dark.png'})
 await page.getByRole('button',{name:'Переключить тему',exact:true}).click();await page.waitForTimeout(400)
 const fixture=[
  {resource:'project',action:'view',granted:false},
  {resource:'process',action:'view',granted:false},
  {resource:'task',action:'view',scope:'process_owner',granted:true},
  {resource:'task',action:'create',scope:'process_owner',granted:true},
  {resource:'task',action:'update',scope:'project_owner',granted:true},
  {resource:'task',action:'delete',granted:false},
  {resource:'resource',action:'view',scope:'self',granted:true},
  {resource:'resource',action:'update',scope:'all',granted:true},
  {resource:'resource',action:'delete',granted:false},
 ]
 for(const [index,permissions] of [fixture,[]].entries()){
  const username='userui'+index+Date.now().toString().slice(-8)
  const r=await call(admin,'POST','user',{username,first_name:'Editor',last_name:'Test',preset:'worker',permissions})
  check(r.status,201,'create disposable user');users.push(r.data.user.id)
 }
 const id=users[0],other=users[1]
 await new Promise(resolve=>setTimeout(resolve,1100))
 await navigate(id)
 await expect(page.locator('.uped-dirty')).toHaveCount(0)
 const initial=await call(admin,'GET','rbac/users/'+id+'/permissions')
 const initialSignature=signature(initial.data.overrides)
 await expect(row('task','manage').locator('.ur-mixed')).toBeVisible()
 await row('task','manage').locator('summary').click()
 await expect(row('task','manage').locator('li')).toHaveText(['Создание: В процессах сотрудника','Изменение: В проектах сотрудника','Удаление: Нет доступа'])
 await choice('task','manage','all').click()
 await expect(active('task','manage')).toHaveText(['Все'])
 await expect(page.locator('.ua-actions button')).toHaveText(['Сохранить','Отменить'])
 await page.locator('.ua-actions').getByRole('button',{name:'Отменить',exact:true}).click()
 await expect(row('task','manage').locator('.ur-mixed')).toBeVisible()
 check(signature((await call(admin,'GET','rbac/users/'+id+'/permissions')).data.overrides),initialSignature,'cancel preserves three independent backend permissions')
 await page.locator('.uped-reset').click()
 await expect(active('task','manage')).toHaveText(['Нет доступа'])
 await page.locator('.ua-actions').getByRole('button',{name:'Отменить',exact:true}).click()
 await expect(row('task','manage').locator('.ur-mixed')).toBeVisible()
 await choice('resource','manage','all').click()
 let release;const gate=new Promise(resolve=>{release=resolve});let puts=0
 const endpoint='**/api/v1/rbac/users/'+id+'/permissions'
 await page.route(endpoint,async route=>{if(route.request().method()==='PUT'){puts++;await gate}await route.continue()})
 await page.locator('.ua-actions').getByRole('button',{name:'Сохранить',exact:true}).click()
 await expect.poll(()=>puts).toBe(1)
 await expect(page.locator('.ua-actions').getByRole('button',{name:'Сохранение…',exact:true})).toBeDisabled()
 await expect(page.locator('.ua-actions').getByRole('button',{name:'Отменить',exact:true})).toBeDisabled()
 await expect(page.locator('.uped-preset-select')).toBeDisabled()
 await expect(choice('resource','manage','self')).toBeDisabled()
 release()
 await expect(page.locator('.ua-actions')).toHaveCount(0)
 await expect(page.locator('.uped-dirty')).toHaveCount(0)
 await page.unroute(endpoint)
 const saved=await call(admin,'GET','rbac/users/'+id+'/permissions');check(saved.status,200,'saved snapshot')
 const management=saved.data.overrides.filter(r=>r.resource==='resource'&&['create','update','delete'].includes(r.action))
 check(management.length,3,'management produces three backend rules')
 check(management.every(r=>r.granted&&r.scope==='all'),true,'all three management rules saved')
 check(signature(saved.data.overrides.filter(r=>r.resource!=='resource')),signature(initial.data.overrides.filter(r=>r.resource!=='resource')),'unrelated task and project rights preserved')
 check(saved.data.overrides.find(r=>r.resource==='resource'&&r.action==='view').scope,'self','resource view remains independent')
 await navigate(id);await expect(active('resource','manage')).toHaveText(['Все']);await expect(row('task','manage').locator('.ur-mixed')).toBeVisible();await expect(page.locator('.uped-dirty')).toHaveCount(0)
 await choice('resource','manage','self').click()
 await page.route(endpoint,async route=>route.request().method()==='PUT'?route.fulfill({status:500,json:{data:null,error:{code:'INTERNAL_ERROR',message:'Simulated permission rejection'}}}):route.continue())
 await page.locator('.ua-actions').getByRole('button',{name:'Сохранить',exact:true}).click()
 await expect(page.locator('.ua-actions').getByRole('button',{name:'Сохранить',exact:true})).toBeEnabled()
 await expect(active('resource','manage')).toHaveText(['Свои'])
 check(signature((await call(admin,'GET','rbac/users/'+id+'/permissions')).data.overrides),signature(saved.data.overrides),'rejected save leaves server unchanged')
 await page.unroute(endpoint)
 await page.locator('.ua-actions').getByRole('button',{name:'Отменить',exact:true}).click();await expect(active('resource','manage')).toHaveText(['Все'])
 await choice('resource','manage','self').click()
 await page.route('**/api/v1/user/'+id,route=>route.request().method()==='PUT'?route.fulfill({status:500,json:{data:null,error:{code:'INTERNAL_ERROR',message:'Simulated role rejection'}}}):route.continue())
 await page.locator('.uped-preset-select').selectOption('rp')
 await expect(page.locator('.uped-preset-select')).toHaveValue('worker')
 await expect(active('resource','manage')).toHaveText(['Свои'])
 await expect(page.locator('.ua-actions')).toBeVisible()
 await page.unroute('**/api/v1/user/'+id)
 await page.locator('.ua-actions').getByRole('button',{name:'Отменить',exact:true}).click()
 await page.locator('.uped-preset-select').selectOption('rp')
 await expect(page.locator('.uped-preset-select')).toBeEnabled()
 await expect(row('task','manage').locator('.ur-mixed')).toBeVisible()
 await expect(page.locator('.ua-actions')).toHaveCount(0)
 check(signature((await call(admin,'GET','rbac/users/'+id+'/permissions')).data.overrides),signature(saved.data.overrides),'changing role preserves saved individual rules')
 await page.evaluate(id=>document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/users/'+id+'/edit/access'),other)
 await expect(active('resource','view')).toHaveText(['Нет доступа'])
 await expect(row('task','manage').locator('.ur-mixed')).toHaveCount(0)
 await expect(page.locator('.uped-dirty')).toHaveCount(0)
 await page.evaluate(id=>document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/users/'+id+'/edit/access'),id)
 await expect(active('resource','manage')).toHaveText(['Все'])
 await expect(row('task','manage').locator('.ur-mixed')).toBeVisible()
 await page.getByRole('button',{name:'Переключить язык',exact:true}).click()
 await expect(page.locator('.ur-cap').filter({hasText:'Manage'})).toHaveCount(15)
 await expect(page.locator('.ur-cap').filter({hasText:'Change priority'})).toHaveCount(1)
 check(user5Writes,0,'real user 5 was not modified')
 const after5=await call(admin,'GET','rbac/users/5/permissions');check(after5.data,before5.data,'real user 5 rules unchanged')
 check(errors,[],'no browser runtime errors')
 console.log('PASS individual editor: grouped management, mixed-rule preservation, initial clean state, cancel/reset/save/reload, failed save and role rollback, busy gates, user navigation, RU/EN, light/dark, widths 360–1440; '+checks+' API assertions')
}finally{
 await browser.close()
 for(const id of users)await call(admin,'DELETE','user/'+id)
 await http.dispose()
}
