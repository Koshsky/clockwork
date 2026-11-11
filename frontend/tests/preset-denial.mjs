import { chromium, request, expect } from 'playwright/test'
import fs from 'node:fs'
const env=Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env',import.meta.url),'utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')]}))
const http=await request.newContext({baseURL:'http://127.0.0.1:8080/api/v1/'})
const tag='deny'+Date.now().toString().slice(-9), dates={start_date:'2026-11-01',end_date:'2026-12-31'}
const browser=await chromium.launch({channel:'chrome',headless:true})
let admin,userID,projectID,resourceID,presetCreated=false,checks=0
async function call(token,method,path,data){
 for(let i=0;i<5;i++){
  const r=await http.fetch(path,{method,data,headers:token?{Authorization:'Bearer '+token}:{}})
  if(r.status()===429){await new Promise(resolve=>setTimeout(resolve,Math.max(1,Number(r.headers()['retry-after'])||1)*1000));continue}
  const text=await r.text(),body=text?JSON.parse(text):{};return{status:r.status(),data:body.data,error:body.error}
 }
 throw new Error('API rate limit persisted')
}
function check(actual,expected,label){expect(actual,label).toEqual(expected);checks++}
async function create(path,data){const r=await call(admin,'POST',path,data);check(r.status,201,path+': '+JSON.stringify(r.error));return r.data.id}
try{
 const login=await call(null,'POST','auth/login',{username:'admin',password:env.ADMIN_PASSWORD});check(login.status,200,'admin login');admin=login.data.access_token
 const preset=await call(admin,'POST','rbac/presets',{tag,name:'Preset denial test'});check(preset.status,201,'create role');presetCreated=true
 const defaults=await call(admin,'GET','rbac/preset-rules');check(defaults.data.filter(r=>r.preset===tag).length,25,'new roles still get 25 default grants')
 const createdUser=await call(admin,'POST','user',{username:tag,first_name:'Preset',last_name:'Denial',preset:tag});check(createdUser.status,201,'create subject');userID=createdUser.data.user.id
 const subject=await call(null,'POST','auth/login',{username:tag,password:createdUser.data.password});check(subject.status,200,'subject login');const token=subject.data.access_token
 projectID=await create('project',{...dates,code:tag,owner_id:userID})
 const processID=await create('process',{...dates,project_id:projectID,title:tag,owner_id:userID})
 const taskID=await create('task',{...dates,process_id:processID,title:tag,owner_id:userID})
 const milestoneID=await create('milestone',{process_id:processID,title:tag,content:'Test',date:'2026-11-10'})
 resourceID=await create('resources',{code:tag,title:tag,owner_id:userID})
 const assignmentID=await create('assignment',{task_id:taskID,resource_id:resourceID,quantity:1})
 const cases=[
  ['Проекты','project',projectID,{code:tag+'-changed'},{...dates,code:tag+'-new',owner_id:userID}],
  ['Процессы','process',processID,{title:'changed'},{...dates,project_id:projectID,title:tag,owner_id:userID}],
  ['Задачи','task',taskID,{title:'changed'},{...dates,process_id:processID,title:tag,owner_id:userID}],
  ['Вехи','milestone',milestoneID,{title:'changed'},{process_id:processID,title:tag,date:'2026-11-10'}],
  ['Назначения ресурсов','assignment',assignmentID,{quantity:2},{task_id:taskID,resource_id:resourceID,quantity:1}],
  ['Ресурсы табеля','resources',resourceID,{title:'changed'},{code:tag+'-new',title:tag,owner_id:userID}],
 ]
 for(const [,path,id]of cases)check((await call(token,'GET',path+'/'+id)).status,200,'baseline own '+path)
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 await page.addInitScript(()=>localStorage.setItem('mvs_erp_auto_sync','0'))
 await page.goto('http://127.0.0.1:5173/login');await page.locator('input[autocomplete=username]').fill('admin');await page.locator('input[autocomplete=current-password]').fill(env.ADMIN_PASSWORD);await page.locator('button[type=submit]').click();await expect(page).not.toHaveURL(/\/login/);await page.waitForLoadState('networkidle')
 const openRole=async()=>{await page.goto('http://127.0.0.1:5173/permissions');const role=page.locator('.pm-preset-btn').filter({hasText:tag});await expect(role).toBeVisible();await role.click()}
 const block=title=>page.locator('.pm-block').filter({has:page.getByText(title,{exact:true})})
 const save=async()=>{await page.locator('.pm-savebar').getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.locator('.pm-savebar')).toHaveCount(0,{timeout:15_000})}
 await openRole()
 for(const [title]of cases){
  for(const row of await block(title).locator('.pm-row').all()){
   if(await row.locator('.pm-chip.on').count())await row.locator('.pm-chip.on').click();else await row.locator('.pm-chip.rev').click();await expect(row.locator('.pm-chip.rev.on')).toHaveCount(1)
  }
  if(await page.locator('.pm-savebar').count())await save()
  for(const row of await block(title).locator('.pm-row').all())await expect(row.locator('.pm-chip.rev.on')).toHaveCount(1)
  // Let the shared local API bucket refill between four-write UI batches.
  await page.waitForTimeout(1000)
 }
 const deniedRules=await call(admin,'GET','rbac/preset-rules');check(deniedRules.data.filter(r=>r.preset===tag).length,0,'all 25 grants removed from storage')
 check((await call(token,'GET','permissions/me')).data.length,0,'subject has no inherited grants')
 await openRole()
 for(const [title,path,id,update,createBody]of cases){
  await expect(block(title).locator('.pm-chip:not(.rev).on')).toHaveCount(0)
  await expect(block(title).locator('.pm-chip.rev.on')).toHaveCount(title==='Проекты'?3:2)
  check((await call(token,'GET',path)).status,403,'denied list '+path)
  expect([403,404]).toContain((await call(token,'GET',path+'/'+id)).status);checks++
  check((await call(token,'POST',path,createBody)).status,403,'denied create '+path)
  check((await call(token,'PUT',path+'/'+id,update)).status,403,'denied update '+path)
  check((await call(token,'DELETE',path+'/'+id)).status,403,'denied delete '+path)
  check((await call(admin,'GET',path+'/'+id)).status,200,'denied mutations preserve '+path)
 }
 const resourceView=block('Ресурсы табеля').locator('.pm-row').first()
 await resourceView.getByRole('button',{name:'Свои',exact:true}).click();await save()
 check((await call(token,'GET','resources/'+resourceID)).status,200,'explicit grant restores access')
 await openRole();await expect(resourceView.locator('.pm-chip.on')).toHaveText(['Свои'])
 const failDelete='**/api/v1/rbac/preset-rules/*'
 await page.route(failDelete,route=>route.request().method()==='DELETE'?route.fulfill({status:503,json:{data:{},error:{code:'TEST_FAILURE',message:'Simulated save rejection'}}}):route.continue())
 await resourceView.locator('.pm-chip.rev').click()
 await page.locator('.pm-savebar').getByRole('button',{name:'Сохранить',exact:true}).click()
 await expect(page.getByText('Simulated save rejection',{exact:true})).toBeVisible()
 await expect(page.locator('.pm-savebar')).toBeVisible();await expect(resourceView.locator('.pm-chip.on')).toHaveText(['Нет доступа'])
 check((await call(token,'GET','resources/'+resourceID)).status,200,'rejected save does not change backend')
 await page.unroute(failDelete)
 const failRefresh='**/api/v1/rbac/matrix'
 await page.route(failRefresh,route=>route.fulfill({status:503,json:{data:{},error:{code:'TEST_REFRESH',message:'Simulated refresh failure'}}}))
 await page.locator('.pm-savebar').getByRole('button',{name:'Сохранить',exact:true}).click()
 await expect(page.getByText('Изменения отправлены, но не удалось обновить права. Повторите сохранение.',{exact:true})).toBeVisible()
 await expect(page.locator('.pm-savebar')).toBeVisible();await expect(resourceView.locator('.pm-chip.on')).toHaveText(['Нет доступа'])
 expect([403,404]).toContain((await call(token,'GET','resources/'+resourceID)).status);checks++
 await page.unroute(failRefresh);await save();await openRole()
 await expect(resourceView.locator('.pm-chip.on')).toHaveText(['Нет доступа'])
 const resourceManage=block('Ресурсы табеля').locator('[data-action-group="manage"]')
 await resourceManage.getByRole('button',{name:'Свои',exact:true}).click();await save()
 let ruleSnapshot=await call(admin,'GET','rbac/preset-rules')
 check(ruleSnapshot.data.filter(r=>r.preset===tag).map(r=>r.action).sort(),['create','delete','update'],'Manage stores three concrete actions only')
 let firstRejected=false
 await page.route(failDelete,route=>{
  if(route.request().method()==='DELETE'&&!firstRejected){firstRejected=true;return route.fulfill({status:503,json:{data:{},error:{code:'TEST_PARTIAL',message:'Simulated partial management failure'}}})}
  return route.continue()
 })
 await resourceManage.locator('.pm-chip.rev').click()
 await page.locator('.pm-savebar').getByRole('button',{name:'Сохранить',exact:true}).click()
 await expect(page.getByText('Simulated partial management failure',{exact:true})).toBeVisible()
 await expect(page.locator('.pm-savebar')).toBeVisible()
 await page.unroute(failDelete)
 await page.locator('.pm-savebar').getByRole('button',{name:'Отменить',exact:true}).click()
 await expect(resourceManage.locator('.pm-mixed')).toBeVisible()
 ruleSnapshot=await call(admin,'GET','rbac/preset-rules')
 check(ruleSnapshot.data.filter(r=>r.preset===tag).length,1,'only rejected concrete permission remains after partial save')
 await resourceManage.locator('.pm-chip.rev').click();await save();await openRole()
 await expect(resourceManage.locator('.pm-chip.on')).toHaveText(['Нет доступа'])
 ruleSnapshot=await call(admin,'GET','rbac/preset-rules');check(ruleSnapshot.data.filter(r=>r.preset===tag).length,0,'retry clears the final concrete grant')
 console.log('PASS preset denial: 25 cells; save/reload; all six entity CRUD/list/by-id denials; explicit re-grant; save rejection and refresh failure preserve drafts; '+checks+' API assertions')
}finally{
 await browser.close()
 if(admin){if(projectID)await call(admin,'DELETE','project/'+projectID);if(resourceID)await call(admin,'DELETE','resources/'+resourceID);if(userID)await call(admin,'DELETE','user/'+userID);if(presetCreated)await call(admin,'DELETE','rbac/presets/'+tag)}
 await http.dispose()
}
