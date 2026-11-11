import {chromium,expect} from 'playwright/test'
import fs from 'node:fs'
const env=Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env',import.meta.url),'utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')]}))
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage({viewport:{width:1440,height:1000}})
page.on('pageerror',e=>console.log('PAGE ERROR',e.message))
await page.addInitScript(()=>localStorage.setItem('mvs_erp_auto_sync','0'))
try{
 await page.goto('http://127.0.0.1:5173/login')
 await page.locator('input[autocomplete=username]').fill('admin');await page.locator('input[autocomplete=current-password]').fill(env.ADMIN_PASSWORD);await page.locator('button[type=submit]').click();await expect(page).not.toHaveURL(/\/login/)
 await page.waitForLoadState('networkidle')
 await page.evaluate(async()=>{
  const s=await import('/src/store/index.ts'),state=await import('/src/offline/state.ts')
  window.ui={app:s.useAppStore(),auth:s.useAuthStore(),rbac:s.useRbacStore(),planning:s.usePlanningStore(),router:document.querySelector('#app').__vue_app__.config.globalProperties.$router,state}
  state.isOffline.value=true
  window.ui.app.users=[{id:42,name:'Subject',preset:'custom'},{id:43,name:'Other',preset:'custom'}]
 })
 const seed=async(permissions,admin=false)=>page.evaluate(({permissions,admin})=>{
  const u=window.ui;u.auth.user={id:42,preset:admin?'admin':'custom',name:'Subject'};u.rbac.myPermissions=permissions;u.rbac.permsLoaded=true;u.state.isOffline.value=true
  u.app.resources=[{id:1,owner_id:42,title:'Own resource',code:'OWN'},{id:2,owner_id:43,title:'Foreign resource',code:'OTHER'}]
 },{permissions,admin})
 const permissions=(actions,scope='self')=>actions.map(action=>({resource:'resource',action,scope}))
 for(const action of ['view','create','update','delete']){
  await seed(permissions([action]));await page.evaluate(()=>window.ui.router.push('/resources'))
  await expect(page.locator('a[href="/resources"]')).toHaveCount(1)
  await expect(page.locator('.rp-add')).toHaveCount(action==='create'?1:0)
 }
 await seed(permissions(['view','create','update','delete'],'none'));await expect(page.locator('a[href="/resources"]')).toHaveCount(0);await expect(page.locator('.rp-add')).toHaveCount(0)
 await seed([]);await expect(page.getByText('Own resource',{exact:true})).toHaveCount(0);await expect(page.getByText('Foreign resource',{exact:true})).toHaveCount(0);await expect(page.locator('a[href="/resources"]')).toHaveCount(0);await expect(page.locator('.rp-add')).toHaveCount(0)
 for(const actions of [['view'],['view','update'],['view','delete'],['view','update','delete']]){
  await seed(permissions(actions));await page.evaluate(()=>window.ui.router.push('/resources'));await expect(page.getByText('Own resource',{exact:true})).toHaveCount(1);await expect(page.getByText('Foreign resource',{exact:true})).toHaveCount(0)
  await page.getByText('Own resource',{exact:true}).dispatchEvent('contextmenu',{button:2,bubbles:true,clientX:600,clientY:300})
  await expect(page.getByRole('menu')).toHaveCount(actions.length>1?1:0)
  if(actions.length>1){await expect(page.getByRole('menuitem')).toHaveCount(actions.length-1);await page.keyboard.press('Escape');await page.mouse.click(1400,900)}
 }
 await seed(permissions(['view'],'all'));await expect(page.getByText('Foreign resource',{exact:true})).toHaveCount(1)
 await seed([...permissions(['view'],'all'),...permissions(['update','delete'])]);await page.getByText('Foreign resource',{exact:true}).dispatchEvent('contextmenu',{button:2,bubbles:true,clientX:600,clientY:300});await expect(page.getByRole('menu')).toHaveCount(0)
 await page.getByText('Own resource',{exact:true}).dispatchEvent('contextmenu',{button:2,bubbles:true,clientX:600,clientY:300});await expect(page.getByRole('menuitem')).toHaveCount(2);await page.mouse.click(1400,900)
 await seed([...permissions(['view']),{resource:'task',action:'view',scope:'all'}])
 await page.evaluate(()=>{window.ui.planning.taskPlanning={processes:[{id:10,owner_id:42,title:'Test process',start_date:'2026-11-01',end_date:'2026-12-31',tasks:[{id:20,owner_id:42,title:'Test task',start_date:'2026-11-09',end_date:'2026-11-22',resources:[]}]}]}})
 await page.evaluate(()=>window.ui.router.push('/planner'))
 await expect(page.locator('.rs-code')).toHaveText(['OWN'])
 await seed([{resource:'task',action:'view',scope:'all'}],true);await expect.poll(()=>page.locator('.rs-code').allTextContents()).toEqual(expect.arrayContaining(['OWN','OTHER']))
 await page.locator('.pp-toolbar select').selectOption('42')

 await expect(page.locator('.rs-code')).toHaveText(['OWN'])
 expect(await page.locator('.gb-handle').count()).toBeGreaterThan(0)
 await page.evaluate(()=>{
  const u=window.ui;u.rbac.myPermissions=[{resource:'rbac_config',action:'view',scope:'all'}];u.rbac.presets=[{tag:'testrole',name:'Test role'},{tag:'second_role_long_tag',name:'Длинное название роли руководителя подразделения и нескольких проектов'}]
  const entities=['resource','project','process','task','milestone','assignment'];const actions=['view','create','update','delete']
  u.rbac.matrix=['testrole','second_role_long_tag'].flatMap(preset=>entities.flatMap(resource=>actions.map(action=>({preset,resource,action,scope:['resource','project'].includes(resource)?'self':'up1'}))))
  u.rbac.presetRules=u.rbac.matrix.map((r,i)=>({...r,id:i+1}))
 })
 await page.evaluate(()=>window.ui.router.push('/permissions'))
 await expect(page.locator('.pm-block')).toHaveCount(6)
 await expect(page.locator('.pm-chip.rev')).toHaveCount(12)
 await expect(page.locator('.pm-block-summary')).toHaveCount(0)
 await expect(page.locator('.pm-preset-btn.active')).toHaveCount(1)
 await expect(page.locator('.pm-preset-btn.active .pm-preset-code')).toHaveText('testrole')
 await expect(page.locator('.pm-presets-title')).toHaveText('Роли')
 const layoutColumns=async()=>page.locator('.pm-editor').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)
 expect(await layoutColumns()).toBe(2)
 await expect(page.locator('.pm-row')).toHaveCount(12)
 expect(await page.locator('.pm').textContent()).not.toMatch(/[⛔✅❌➕]/)
 await expect(page.locator('.pm-block').first().locator('.pm-row-label')).toHaveText(['Просмотр','Управление'])
 const firstCards=await page.locator('.pm-column').evaluateAll(nodes=>nodes.map(el=>{const r=el.querySelector('.pm-block').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}}))
 expect(Math.abs(firstCards[0].y-firstCards[1].y)).toBeLessThan(1)
 expect(firstCards[1].x).toBeGreaterThan(firstCards[0].x+firstCards[0].width)
 const columnGaps=await page.locator('.pm-column').evaluateAll(columns=>columns.flatMap(col=>[...col.querySelectorAll('.pm-block')].slice(1).map((card,i)=>card.getBoundingClientRect().top-col.querySelectorAll('.pm-block')[i].getBoundingClientRect().bottom)))
 expect(columnGaps.length).toBeGreaterThan(0)
 for(const gap of columnGaps){expect(gap).toBeGreaterThanOrEqual(0);expect(gap).toBeLessThanOrEqual(13)}
 const actionHeads=await page.locator('.pm-block').first().locator('.pm-row-label').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})))
 for(let i=1;i<actionHeads.length;i++){expect(actionHeads[i].x).toBeGreaterThan(actionHeads[i-1].x);expect(Math.abs(actionHeads[i].y-actionHeads[0].y)).toBeLessThan(1)}
 const roleText=await page.locator('.pm-preset-btn.active').evaluate(el=>({code:el.querySelector('.pm-preset-code').getBoundingClientRect().bottom,name:el.querySelector('.pm-preset-name').getBoundingClientRect().top}))
 expect(roleText.name).toBeGreaterThanOrEqual(roleText.code)
 for(const [width,columns] of [[1440,2],[900,2],[390,1]]){
  await page.setViewportSize({width,height:1000});await expect.poll(layoutColumns).toBe(columns)
  const fits=await page.locator('.pm').evaluate(el=>el.scrollWidth<=el.clientWidth+1)
  expect(fits,'permission page fits width '+width).toBe(true)
  if(columns===1){
   await expect.poll(async()=>{
    return page.locator('.pm-block').evaluateAll(nodes=>nodes.map(el=>Number(el.dataset.order)))
   }).toEqual([0,1,2,3,4,5])
   const order=await page.locator('.pm-block').evaluateAll(nodes=>nodes.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).map(el=>Number(el.dataset.order)))
   expect(order).toEqual([0,1,2,3,4,5])
   expect(await page.locator('.pm-block').evaluateAll(nodes=>nodes.map(el=>Number(el.dataset.order)))).toEqual(order)
  }
 }
 await page.setViewportSize({width:1440,height:1000})
 for(const row of await page.locator('.pm-row').all()){
  if(await row.locator('.pm-chip.on').count())await row.locator('.pm-chip.on').click();else await row.locator('.pm-chip.rev').click()
  await expect(row.locator('.pm-chip.rev.on')).toHaveCount(1)
  await row.locator('.pm-chip.rev').click()
  await expect(row.locator('.pm-chip.rev.on')).toHaveCount(1)
 }
 await page.locator('.pm-savebar').getByRole('button',{name:'Отменить',exact:true}).click()
 await page.evaluate(()=>{
  const u=window.ui
  u.rbac.matrix=u.rbac.matrix.map(r=>r.preset==='testrole'&&r.resource==='task'&&r.action==='create'?{...r,scope:'all'}:r)
 })
 const mixedManage=page.locator('.pm-block').filter({has:page.getByText('Задачи',{exact:true})}).locator('[data-action-group="manage"]')
 await expect(mixedManage.locator('.pm-mixed')).toBeVisible()
 await expect(mixedManage.locator('.pm-chip.on')).toHaveCount(0)
 await mixedManage.locator('summary').click()
 await expect(mixedManage.locator('li')).toHaveText(['Создание: Все','Изменение: В процессах сотрудника','Удаление: В процессах сотрудника'])
 await mixedManage.getByRole('button',{name:'В проектах сотрудника',exact:true}).click()
 await expect(mixedManage.locator('.pm-mixed')).toHaveCount(0)
 await expect(mixedManage.locator('.pm-chip.on')).toHaveText(['В проектах сотрудника'])
 await page.locator('.pm-savebar').getByRole('button',{name:'Отменить',exact:true}).click()
 await expect(mixedManage.locator('.pm-mixed')).toBeVisible()
 await page.evaluate(()=>{window.ui.rbac.matrix=window.ui.rbac.matrix.map(r=>r.preset==='testrole'&&r.resource==='task'&&r.action==='create'?{...r,scope:'up1'}:r)})

 for(const [title,scope] of [['Процессы','В проектах сотрудника'],['Задачи','В процессах сотрудника']]){
  const block=page.locator('.pm-block').filter({has:page.getByText(title,{exact:true})})
  await expect(block.getByRole('button',{name:'Свои',exact:true})).toHaveCount(0)
  await expect(block.getByRole('button',{name:scope,exact:true})).toHaveCount(2)
  await expect(block.locator('.pm-chip.on')).toHaveCount(2)
 }
 await expect(page.getByRole('button',{name:/^(Поддерево|Предки)$/})).toHaveCount(0)
 const processes=page.locator('.pm-block').filter({has:page.getByText('Процессы',{exact:true})})
 await expect(processes.getByRole('button',{name:'По общему проекту',exact:true})).toHaveCount(0)
 await expect(processes.getByRole('button',{name:'С задачами сотрудника',exact:true})).toHaveCount(0)
 const exactProcess=processes.locator('.pm-row').first().getByRole('button',{name:'В процессах сотрудника',exact:true})
 await exactProcess.click()
 await expect(processes.locator('.pm-row').first().locator('.pm-chip.on')).toHaveCount(2)
 await exactProcess.click()
 const tasksBlock=page.locator('.pm-block').filter({has:page.getByText('Задачи',{exact:true})})
 for(const name of ['По общему процессу','По общему проекту']) await expect(tasksBlock.getByRole('button',{name,exact:true})).toHaveCount(0)
 const taskRow=tasksBlock.locator('.pm-row').first()
 await expect(taskRow.locator('.pm-chip')).toHaveText(['Все','В проектах сотрудника','В процессах сотрудника','Только через родителя'])
 const verticalOptions=await taskRow.locator('.pm-chip').evaluateAll(nodes=>nodes.map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,bottom:r.bottom}}))
 for(let i=1;i<verticalOptions.length;i++){
  expect(Math.abs(verticalOptions[i].x-verticalOptions[0].x)).toBeLessThan(1)
  expect(verticalOptions[i].y).toBeGreaterThanOrEqual(verticalOptions[i-1].bottom)
 }
 const allTasks=taskRow.getByRole('button',{name:'Все',exact:true})
 await allTasks.click();await expect(taskRow.locator('.pm-chip.on')).toHaveText(['Все'])
 await allTasks.click();await expect(taskRow.locator('.pm-chip.on')).toHaveText(['Только через родителя'])
 await page.locator('.pm-preset-btn').filter({hasText:'second_role_long_tag'}).click()
 await page.locator('.pm-preset-btn').filter({hasText:'testrole'}).click()
 await expect(taskRow.locator('.pm-chip.on')).toHaveText(['Только через родителя'])
 await allTasks.click();await expect(taskRow.locator('.pm-chip.on')).toHaveText(['Все'])
 await page.locator('.pm-preset-btn').filter({hasText:'second_role_long_tag'}).click()
 await expect(taskRow.locator('.pm-chip.on')).toHaveText(['В процессах сотрудника'])
 await page.locator('.pm-preset-btn').filter({hasText:'testrole'}).click()
 await expect(taskRow.locator('.pm-chip.on')).toHaveText(['Все'])
 await page.locator('.pm-savebar').getByRole('button',{name:'Отменить',exact:true}).click()
 await expect(taskRow.locator('.pm-chip.on')).toHaveText(['В процессах сотрудника'])
 const secondRole=page.locator('.pm-preset-item').filter({hasText:'second_role_long_tag'})
 await secondRole.locator('.pm-preset-remove').click()
 await expect(page.locator('.pm-del')).toBeVisible()
 await expect(page.locator('.pm-del-input')).toHaveAttribute('placeholder','second_role_long_tag')
 await expect(page.locator('.pm-preset-btn.active .pm-preset-code')).toHaveText('testrole')
 await page.locator('.pm-del').getByRole('button',{name:'Отмена',exact:true}).click()
 await page.locator('.pm-preset-btn.active').dispatchEvent('contextmenu',{button:2,bubbles:true,clientX:200,clientY:250})
 await expect(page.getByRole('menuitem',{name:'Переименовать',exact:true})).toBeVisible()
 await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0)
 for(const colorScheme of ['dark','light']){
  if(await page.locator('html').getAttribute('data-scheme')!==colorScheme) await page.getByRole('button',{name:'Переключить тему',exact:true}).dispatchEvent('click')
  await expect.poll(()=>page.locator('html').getAttribute('data-scheme')).toBe(colorScheme)
  const roleStyle=await page.locator('.pm-preset-btn.active').evaluate(el=>({button:getComputedStyle(el).color,code:getComputedStyle(el.querySelector('.pm-preset-code')).color,name:getComputedStyle(el.querySelector('.pm-preset-name')).color,codeSize:parseFloat(getComputedStyle(el.querySelector('.pm-preset-code')).fontSize),nameSize:parseFloat(getComputedStyle(el.querySelector('.pm-preset-name')).fontSize)}))
  expect(roleStyle.code).toBe(roleStyle.button);expect(roleStyle.name).toBe(roleStyle.button)
  expect(roleStyle.codeSize).toBeLessThan(roleStyle.nameSize)
 }
 await page.locator('.pm-head').scrollIntoViewIfNeeded()
 await page.screenshot({path:'/tmp/erp-permission-layout-desktop.png'})

 await page.evaluate(()=>{
   window.ui.rbac.matrix=window.ui.rbac.matrix.map(r=>r.preset==='testrole'&&r.resource==='project'&&r.action==='view'?{...r,scope:'all'}:r)
 })
 await expect(taskRow.locator('.pm-chip.on')).toHaveText(['Все'])
 for(const button of await taskRow.locator('.pm-chip').all())await expect(button).toBeDisabled()
 const taskManage=tasksBlock.locator('[data-action-group="manage"]')
 await expect(taskManage.getByRole('button',{name:'Все',exact:true})).toBeEnabled()
 await page.locator('.pm-head .hb').click()
 await expect(page.getByText('Как настроить права роли',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'Переключить язык',exact:true}).dispatchEvent('click')
 await expect(page.getByText('Set up a role',{exact:true})).toBeVisible()
 await expect(page.locator('.pm-presets-title')).toHaveText('Roles')
 const englishProcesses=page.locator('.pm-block').filter({has:page.getByText('Processes',{exact:true})})
 await expect(englishProcesses.getByRole('button',{name:'In the same project',exact:true})).toHaveCount(0)
 const englishTasks=page.locator('.pm-block').filter({has:page.getByText('Tasks',{exact:true})})
 await expect(englishTasks.getByRole('button',{name:'In the same process',exact:true})).toHaveCount(0)
 await expect(englishTasks.getByRole('button',{name:'In employee-owned processes',exact:true})).toHaveCount(2)
 await expect(page.getByText('Viewing inherited from a parent · controls locked',{exact:false}).first()).toBeVisible()
 console.log('PASS UI: four independent navigation gates; create gate; view/update/delete/context menus; own/all lists; owner-only header; administrator all-resource mode and resource-only owner filtering; six preset blocks with explicit denials; deselect all/last grant, repeated denial click, role switch and cancellation; independent page columns without row gaps, View/Manage columns with explicit mixed scopes, mobile reading order, vertical scope order, responsive widths, stacked role labels, independent staged role changes and delete/context menu controls')
}finally{await browser.close()}
