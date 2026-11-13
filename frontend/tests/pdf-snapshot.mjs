import { chromium, expect } from 'playwright/test'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PNG } from 'pngjs'
import { PDFDocument } from 'pdf-lib'
import { launchElectronFixture } from './helpers/electron.mjs'
const web = process.env.ERP_TEST_URL, api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !web || !api || [web, api].some(url => !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))) throw new Error('An isolated loopback test stack is required')
const output = fs.mkdtempSync('/tmp/clockwork-pdf-snapshot-')
// Match the web fixture's sRGB, 1x viewport independently of the host monitor.
process.env.ERP_TEST_DEVICE_SCALE = '1'
const native = process.env.ERP_TEST_DESKTOP === '1' ? await launchElectronFixture() : null
const browser = native ? null : await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true })
const page = native ? await native.app.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
async function download(destination) {
 if (native) {
  const count = await native.app.evaluate(() => globalThis.cspDownloads.length)
  await page.locator('.pe-btn-download').click()
  await expect.poll(() => native.app.evaluate(() => globalThis.cspDownloads.length), { timeout: 30000 }).toBe(count + 1)
  const result = await native.app.evaluate(() => globalThis.cspDownloads.at(-1))
  expect(result.state).toBe('completed'); fs.copyFileSync(result.path, destination)
 } else {
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('.pe-btn-download').click()])
  await file.saveAs(destination)
 }
}
let account, access
async function fixture(method, route, body) {
 const result = await fetch(api + '/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: 'Bearer ' + access } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
 if (!result.ok) throw new Error('PDF fixture ' + method + ' ' + route + ': ' + result.status)
 return result.status === 204 ? null : (await result.json()).data
}
const errors = []
page.on('pageerror', error => errors.push(error.stack ?? error.message))
await page.addInitScript(() => localStorage.setItem('mvs_erp_auto_sync', '0'))
function diff(a, b) {
 const one = PNG.sync.read(a), two = PNG.sync.read(b)
 expect([two.width, two.height]).toEqual([one.width, one.height])
 let bad = 0, total = 0
 for (let i = 0; i < one.data.length; i += 4) {
  let max = 0
  for (let c = 0; c < 3; c++) { const d = Math.abs(one.data[i+c] - two.data[i+c]); max = Math.max(max, d); total += d }
  if (max > 24) bad++
 }
 return { different: bad / (one.width * one.height), mean: total / (one.width * one.height * 3) }
}
try {
 access = (await fixture('POST', '/auth/login', { username: 'admin', password })).access_token
 account = await fixture('POST', '/user', { username: 'pdf' + randomUUID().slice(0, 8), preset: 'vp', first_name: 'PDF', last_name: 'Fixture' })
 await fixture('PUT', '/rbac/users/' + account.user.id + '/permissions', { overrides: ['project', 'process', 'task', 'resource', 'worker'].map(resource => ({ resource, action: 'view', scope: 'all', granted: true })) })
 await page.goto(web + '/login')
 await page.locator('input[autocomplete=username]').fill(account.user.username)
 await page.locator('input[autocomplete=current-password]').fill(account.password)
 await page.locator('button[type=submit]').click()
 await expect(page).not.toHaveURL(/\/login/)
 await page.waitForLoadState('networkidle')
 await page.evaluate(async () => (await import('/src/platform/current.ts')).currentRuntime.value?.stop())
 if (native) await native.app.evaluate(async () => { await globalThis.syncFixture.stop(); await globalThis.sessionFixture.enterOffline() })
 if (native) await expect.poll(() => page.evaluate(async () => (await import('/src/store/index.ts')).useAuthStore().sessionMode)).toBe('offline')
 await page.addStyleTag({content:'.reconnect-toast {display:none !important}'})
 await page.evaluate(async () => {
  const s = await import('/src/store/index.ts'), offline = await import('/src/offline/state.ts')
  window.pdfMutation = (await import('/src/offline/mutationGuard.ts')).beginMutation()
  offline.isOffline.value = true
  const app=s.useAppStore(), planning=s.usePlanningStore(), auth=s.useAuthStore(), rbac=s.useRbacStore()
  const ownId = window.erpDesktop?.service?.businessProtocol === 1 ? auth.user.id : 42
  const colleagueId = ownId + 1, otherId = ownId + 2
  if (!window.erpDesktop?.service?.businessProtocol) auth.user={...auth.user,id:ownId,preset:'vp'}
  rbac.permsLoaded=true
  rbac.myPermissions=['project','process','task','resource'].map(resource=>({resource,action:'view',scope:'all'}))
  const users=[{id:ownId,name:'Шмонов Михаил Владимирович',last_name:'Шмонов',first_name:'Михаил',middle_name:'Владимирович'},{id:colleagueId,name:'Иванова Анна',last_name:'Иванова',first_name:'Анна'},{id:otherId,name:'Петров Игорь Сергеевич',last_name:'Петров',first_name:'Игорь',middle_name:'Сергеевич'}]
  app.users=users;app.myStaff=users
  app.resources=[{id:1,owner_id:ownId,code:'ENG',title:'Engineers',employees_count:4},{id:2,owner_id:ownId,code:'QA',title:'Testers',employees_count:3}]
  if (window.erpDesktop?.service?.businessProtocol === 1) {
   const contextId = (await window.erpDesktop.session.status()).contextId
   for (const owner of ['all', String(ownId)]) await window.erpDesktop.queue.request({ action: 'cachePut', key: '/local/resource-header?owner_id=' + owner, value: { ts: Date.now(), data: JSON.parse(JSON.stringify(app.resources)) }, contextId })
  }
  app.calendar=app.resources.map(r=>({resource_id:r.id,periods:[{start_date:'2026-01-01',end_date:'2027-12-31',available:r.employees_count}]}))
  const dates={start_date:'2026-10-01',end_date:'2027-02-28'}
  planning.taskPlanning={processes:Array.from({length:30},(_,n)=>({id:201+n,project_id:101+n,project_code:`PRJ-${n+1}`,owner_id:n%2?colleagueId:ownId,project_owner_id:ownId,title:`Process ${n+1}`,...dates,
   tasks:Array.from({length:8},(_,i)=>({id:1000+n*10+i,process_id:201+n,title:`Task ${n+1}.${i+1}`,owner_id:ownId,responsible_id:colleagueId,color:['#da532c','#1e8b78','#6356bd'][i%3],start_date:`2026-11-${String(1+i*2).padStart(2,'0')}`,end_date:`2026-11-${String(11+i*2).padStart(2,'0')}`,resources:[{id:1,assignment_id:3000+n*10+i,code:'ENG',quantity:1}],subtasks:[{id:5000+n*10+i,title:'Check',status:'done'}]})),
   milestones:[{id:4000+n,title:`Milestone ${n+1}`,date:'2026-11-12',color:'#bb386c'}],dependencies:[{id:n+1,task_id:1000+n*10+2,depends_on_task_id:1000+n*10,type:'fs'}]
  }))}
  planning.projectPlanning={projects:planning.taskPlanning.processes.map(p=>({id:p.project_id,project_code:p.project_code,owner_id:ownId,...dates}))}
  planning.processPlanning={projects:planning.taskPlanning.processes.map(p=>({id:p.project_id,project_code:p.project_code,owner_id:ownId,...dates,processes:[{...p}]}))}
  window.pdfTest={s,app,planning,router:document.querySelector('#app').__vue_app__.config.globalProperties.$router,snapshot:await import('/src/components/planner/PdfExport/snapshot.ts')}
  const settings=await import('/src/settings.ts')
  for(const key of ['badgeTaskProjectCode','badgeTaskOwner','badgeTaskResponsible','badgeTaskResources','badgeTaskSubtasks','badgeProcessProjectCode','badgeProcessOwner','badgeProcessResponsible','badgeProjectOwner','badgeProjectResponsible']) settings.viewSettings[key]=true
  settings.viewSettings.showPdfButtons=true
  await window.pdfTest.router.push('/planner?process=201')
 })
 await expect(page.locator('.gantt-bar').first()).toBeAttached()
 const scenarios=process.env.PDF_SELECTION_ONLY ? [] : process.env.PDF_FAST ? [['tasks','/planner?process=201']] : [['tasks','/planner?process=201'],['processes','/processes?project=101'],['projects','/projects']]
 for (const [scope,route] of scenarios) {
  await page.evaluate(route=>window.pdfTest.router.push(route),route)
  await expect(page.locator('.tg-scroll')).toHaveCount(1)
  for (const scheme of ['light','dark']) {
   await page.evaluate(async scheme=>(await import('/src/theme.ts')).setScheme(scheme),scheme)
  for (const unit of ['day','week']) {
   await page.evaluate(unit=>{let vm=document.querySelector('.tg-scroll').__vueParentComponent;while(vm && !['PlannerPage','ProjectsPage','ProcessesPage'].includes(vm.type.__name))vm=vm.parent;vm.setupState.unit=unit},unit)
   await page.waitForTimeout(400)
   for(const zoom of [1,0.75,1.5]) {
    await page.evaluate(async ({zoom,scope})=>{
     const scroll=document.querySelector('.tg-scroll')
     let vm=scroll.__vueParentComponent
     while(vm && vm.type.__name!=='TimelineGrid')vm=vm.parent
     vm.setupState.ctx.scale=zoom
     scroll.querySelector('.tg-content').style.zoom=String(zoom)
     await (await import('/node_modules/.vite/deps/vue.js')).nextTick()
     const calendar=await import('/src/components/planner/calendar.ts')
     const ctx=vm.setupState.ctx
     const index=calendar.cellIndexForDate(ctx.origin,ctx.unit,'2026-11-03')
     scroll.scrollTop=scope==='projects'?75:240
     scroll.scrollLeft=(ctx.cellLeft(index)-180)*zoom+17
     scroll.dispatchEvent(new Event('scroll'))
    },{zoom,scope})
    await page.waitForTimeout(250)
    const rect=await page.locator('.tg-scroll').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:el.clientWidth,height:el.clientHeight}})
    const original=await page.screenshot({clip:rect})
    const captured=await page.evaluate(async scope=>{
     const {snapshot:mod}=window.pdfTest
     window.frozen?.dispose()
     window.frozen=mod.freezeDiagram(document.querySelector('.tg-scroll'))
     const groups=scope==='tasks'?window.pdfTest.planning.taskPlanning.processes.map(p=>({id:p.id,rows:p.tasks})):scope==='processes'?window.pdfTest.planning.processPlanning.projects.map(p=>({id:p.id,rows:p.processes})):[{id:'projects',rows:window.pdfTest.planning.projectPlanning.projects}]
     window.captureOptions={groups,scope,showMilestones:true,showTodayLine:true,showResources:true,style:'color',barThickness:window.frozen.barThickness}
     return (await mod.snapshotCanvas(window.frozen,window.captureOptions,window.devicePixelRatio)).toDataURL()
    },scope)
    const png=Buffer.from(captured.split(',')[1],'base64')
    const name=`${scope}-${scheme}-${unit}-${zoom}`
    fs.writeFileSync(`${output}/${name}-screen.png`,original)
    fs.writeFileSync(`${output}/${name}-capture.png`,png)
    const comparison=diff(original,png)
    expect(comparison.different, name+' pixel mismatch').toBeLessThan(0.012)
    expect(comparison.mean, name+' mean channel error').toBeLessThan(1.5)
    console.log('PASS',name,comparison)
   }
  }
  }
 }

 await page.evaluate(async()=>{
  const {router}=window.pdfTest
  await router.push('/planner?process=201')
  let vm=document.querySelector('.tg-scroll').__vueParentComponent;while(vm && vm.type.__name!=='PlannerPage')vm=vm.parent;vm.setupState.unit='week'
 })
 await page.waitForTimeout(400)
 // Keep both scrolled axes and a non-default scale when opening via either shortcut.
 const before=await page.locator('.tg-scroll').evaluate(el=>({left:el.scrollLeft,top:el.scrollTop,zoom:el.querySelector('.tg-content').style.zoom}))
 const outputRect=await page.locator('.tg-scroll').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:el.clientWidth,height:el.clientHeight}})
 await page.screenshot({clip:outputRect,scale:'css',path:`${output}/current-view-screen.png`})
 await page.keyboard.press('Control+s')
 await expect(page.locator('.pe-modal')).toHaveCount(1)
 await expect(page.getByText('Область печати',{exact:true})).toHaveCount(0)
 await expect(page.getByText('Стиль диаграммы',{exact:true})).toHaveCount(0)
 await expect.poll(()=>page.locator('.pe-pages canvas').count(),{timeout:45000}).toBeGreaterThan(1)
 await expect(page.locator('.pe-updating')).toHaveCount(0)
 expect(await page.locator('.tg-scroll').evaluate(el=>({left:el.scrollLeft,top:el.scrollTop,zoom:el.querySelector('.tg-content').style.zoom}))).toEqual(before)
 await page.keyboard.press('Control+p')
 await expect(page.locator('.pe-modal')).toHaveCount(1)
 await download(`${output}/all-rows.pdf`)
 const bytes=fs.readFileSync(`${output}/all-rows.pdf`)
 expect(bytes.subarray(0,5).toString()).toBe('%PDF-')
 const document=await PDFDocument.load(bytes)
 expect(document.getPageCount()).toBeGreaterThan(1)
 expect(document.getPage(0).getSize()).toEqual({width:outputRect.width*0.75,height:outputRect.height*0.75})
 await expect(page.locator('.pe-modal')).toHaveCount(0)
 console.log('PASS complete selection PDF, shortcuts and source geometry')
 await page.evaluate(()=>{window.pdfTest.planning.taskPlanning.processes=window.pdfTest.planning.taskPlanning.processes.slice(0,4)})
 // The export button may be hidden while the keyboard shortcuts remain available.
 await page.evaluate(async()=>{(await import('/src/settings.ts')).viewSettings.showPdfButtons=false})
 await page.keyboard.press('Control+p')
 await expect.poll(()=>page.locator('.pe-pages canvas').count(),{timeout:45000}).toBeGreaterThan(0)
 await expect(page.locator('.pe-updating')).toHaveCount(0)
 const settle=async()=>{await page.waitForTimeout(450);await expect(page.locator('.pe-updating')).toHaveCount(0,{timeout:30000})}
 const preview=()=>page.locator('.pe-pages canvas').first().evaluate(canvas=>canvas.toDataURL())
 let previous=await preview()
 await page.locator('.pe-settings label').filter({hasText:'Только мои процессы'}).locator('input').check()
 await settle()
 expect(await preview()).not.toBe(previous)
 await page.locator('.pe-settings label').filter({hasText:'Только мои процессы'}).locator('input').uncheck()
 await settle()
 await page.locator('.pe-filters-toggle').filter({hasText:'Процессы'}).click()
 await page.locator('.pe-filter-item').filter({has:page.getByText('Process 2',{exact:true})}).locator('input').check()
 await settle()
 await page.locator('.pe-filters-toggle').filter({hasText:'Скрыть проекты'}).click()
 await page.locator('.pe-filter-item').filter({has:page.getByText('PRJ-2',{exact:true})}).locator('input').check()
 await settle()
 await expect(page.locator('.pe-btn-download')).toBeDisabled()
 await expect(page.locator('.pe-msg')).toHaveText('Нет данных для печати — измените фильтры')
 await page.locator('.pe-filter-item').filter({has:page.getByText('PRJ-2',{exact:true})}).locator('input').uncheck()
 await page.locator('.pe-filter-item').filter({has:page.getByText('Process 2',{exact:true})}).locator('input').uncheck()
 await settle()
 previous=await preview()
 await expect(page.locator('input[value=mono],input[value=color]')).toHaveCount(0)
 console.log('PASS process/project filters and empty selection')
 await page.locator('.pe-range').fill('40')
 await settle()
 expect(await preview()).not.toBe(previous)
 const sourceCounts=await page.locator('.tg-scroll').evaluate(el=>({resources:el.querySelectorAll('.rs-cell').length,milestones:el.querySelectorAll('.ms').length,bars:el.querySelectorAll('.gantt-bar').length}))
 for (const label of ['Показывать занятость ресурсов','Показывать вехи','Показывать линию «сегодня»']) {
  await page.locator('.pe-settings label').filter({hasText:label}).locator('input').uncheck()
 }
 await page.waitForTimeout(500)
 await expect(page.locator('.pe-updating')).toHaveCount(0,{timeout:30000})
 await download(`${output}/filtered-view.pdf`)
 expect(fs.readFileSync(`${output}/filtered-view.pdf`).equals(fs.readFileSync(`${output}/all-rows.pdf`))).toBe(false)
 expect(await page.locator('.tg-scroll').evaluate(el=>({resources:el.querySelectorAll('.rs-cell').length,milestones:el.querySelectorAll('.ms').length,bars:el.querySelectorAll('.gantt-bar').length}))).toEqual(sourceCounts)
 await page.keyboard.press('Control+p')
 await expect.poll(()=>page.locator('.pe-pages canvas').count(),{timeout:45000}).toBeGreaterThan(0)
 await expect(page.locator('.pe-updating')).toHaveCount(0)
 await page.evaluate(()=>{
  window.printCalls=0
  const create=document.createElement.bind(document)
  document.createElement=function(tag,...args){
   const element=create(tag,...args)
   if(tag==='iframe')queueMicrotask(()=>{if(element.contentWindow)element.contentWindow.print=()=>{window.printCalls++;element.contentWindow.dispatchEvent(new Event('afterprint'))}})
   return element
  }
 })
 console.log('PASS display toggles and bar thickness')
 await page.locator('.pe-btn-primary').click()
 await expect.poll(()=>page.evaluate(()=>window.printCalls)).toBe(1)
 await expect(page.locator('.pe-modal')).toHaveCount(0)
 await page.keyboard.press('Control+s')
 await expect(page.locator('.pe-modal')).toHaveCount(1)
 await page.keyboard.press('Escape')
 await expect(page.locator('.pe-modal')).toHaveCount(0)
 console.log('PASS shortcuts, download, print, display toggles, isolated source and hidden export button')
 expect(errors).toEqual([])
 console.log('PDF artifacts:', output)
} catch (error) {
 console.error('PDF fixture state', errors, await page.evaluate(async () => { const s = await import('/src/store/index.ts'); return { user: s.useAuthStore().user?.id, preset: s.useAuthStore().user?.preset, tasks: s.usePlanningStore().taskPlanning?.processes?.length, projects: s.usePlanningStore().projectPlanning?.projects?.length, error: s.usePlanningStore().error, perms: s.useRbacStore().myPermissions, busy: (await import('/src/offline/mutationGuard.ts')).hasActiveMutations() } }))
 throw error
} finally {
 if (native) await native.close(); else await browser.close()
 if (account) await fixture('DELETE', '/user/' + account.user.id)
}
