import { chromium, _electron, expect } from 'playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const web=process.env.ERP_TEST_URL, api=process.env.ERP_TEST_API, password=process.env.ERP_TEST_PASSWORD
if(process.env.ERP_TEST_ISOLATED!=='1'||!password||![web,api].every(url=>url&&['localhost','127.0.0.1'].includes(new URL(url).hostname)))throw new Error('Explicit isolated local services are required')
const report=[], errors=[]
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true})
const context=await browser.newContext()
await context.addInitScript(()=>{localStorage.setItem('mvs_erp_auto_sync','0');Object.defineProperty(window,'indexedDB',{value:undefined});Object.defineProperty(window,'BroadcastChannel',{value:undefined})})
async function login(page,username='admin',secret=password){
  await page.goto(web+'/login');await page.locator('input[autocomplete=username]').fill(username);await page.locator('input[autocomplete=current-password]').fill(secret);await page.locator('button[type=submit]').click();await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 15000 });await page.evaluate(async()=>{const auth=(await import('/src/store/index.ts')).useAuthStore();await auth.waitForSessionRefresh();auth.stopBackgroundSession()})
}
async function auth(page,operation){return page.evaluate(async operation=>(await import('/src/store/index.ts')).useAuthStore()[operation](),operation)}
let electron=null, profile=null, token=null
const external=async(method,route,body)=>{
  const res=await fetch(api+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)})
  const data=res.status===204?{}:await res.json();if(!res.ok)throw new Error('Fixture '+method+' '+route+' status '+res.status+': '+data.error?.message);return data.data
}
try{
  const first=await context.newPage();first.on('pageerror',error=>errors.push(error.message))
  let loginBody
  first.on('response',async response=>{if(response.url().endsWith('/auth/login')&&response.status()===200)loginBody=await response.json()})
  await login(first);await expect.poll(()=>Boolean(loginBody)).toBe(true)
  expect(loginBody.data.refresh_token).toBeUndefined()
  const cookie=(await context.cookies()).find(item=>item.name==='mvs_refresh');expect(cookie?.httpOnly).toBe(true);expect(cookie?.sameSite).toBe('Strict')
  expect(await first.evaluate(()=>[localStorage.getItem('mvs_erp_session_state'),localStorage.getItem('mvs_erp_session_token')])).toEqual([null,null])
  report.push('WEB PASS: cookie-only login without IndexedDB and without persisted broadcast credentials')
  const second=await context.newPage();await second.goto(web+'/projects');await expect(second.locator('.ah-burger')).toBeVisible()
  expect(await Promise.all([first,second].map(page=>auth(page,'refreshSession')))).toEqual([true,true])
  await Promise.all([first,second].map(page=>page.reload()));await expect(first.locator('.ah-burger')).toBeVisible();await expect(second.locator('.ah-burger')).toBeVisible()
  report.push('WEB PASS: concurrent refresh and reload in two tabs')
  let calls=0
  await first.route('**/auth/refresh',async route=>{calls++;const result=await route.fetch({headers:{...route.request().headers(),'Sec-Fetch-Site':'same-origin'}});expect(result.status()).toBe(200);await route.abort('failed')})
  await auth(first,'refreshSession');expect(await auth(first,'refreshSession')).toBe(false);expect(calls).toBe(1)
  await first.unroute('**/auth/refresh');await login(first)
  report.push('WEB PASS: lost response after committed refresh is not replayed; manual login recovers')
  let release,held=false
  await first.route('**/auth/refresh',async route=>{const result=await route.fetch({headers:{...route.request().headers(),'Sec-Fetch-Site':'same-origin'}});held=true;await new Promise(resolve=>{release=resolve});await route.fulfill({response:result})})
  await first.evaluate(async()=>(await import('/src/token.ts')).setAccessToken(null))
  const refreshing=auth(first,'refreshSession');await expect.poll(()=>held).toBe(true)
  await auth(second,'logout');release();expect(await refreshing).toBe(false)
  await expect.poll(async()=>(await context.cookies()).some(item=>item.name==='mvs_refresh')).toBe(false)
  expect(await first.evaluate(async()=>(await import('/src/store/index.ts')).useAuthStore().isAuthenticated)).toBe(false)
  await first.unroute('**/auth/refresh');report.push('WEB PASS: logout wins over a late refresh in another tab')
  await context.close();await browser.close()

  if(!process.env.ELECTRON_EXECUTABLE)throw new Error('Native Electron is required')
  profile=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-session-e2e-'))
  async function launch(offline=false){
    const env={...process.env,ERP_CSP_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
    electron=await _electron.launch({executablePath:process.env.ELECTRON_EXECUTABLE,args:[fileURLToPath(new URL('./electron-main.cjs',import.meta.url))],env})
    const page=await electron.firstWindow();page.on('pageerror',error=>errors.push(error.message))
    await electron.context().addInitScript(api=>{localStorage.setItem('mvs_erp_api_url',api+'/api/v1');localStorage.setItem('mvs_erp_auto_sync','0')},api)
    await electron.evaluate(({net},offline)=>{
      globalThis.sessionCalls=[];globalThis.sessionFault=offline?'offline':null
      globalThis.sessionFetchOverride=async(url,options,next)=>{
        const route=new URL(url).pathname
        globalThis.sessionCalls.push({route,method:options.method,authorized:Boolean(options.headers.Authorization),key:options.headers['Idempotency-Key']})
        if(globalThis.sessionFault==='offline')throw new Error('isolated network outage')
        const response=await next(url,options)
        if(route.endsWith('/auth/refresh')&&globalThis.sessionFault==='lose-refresh') {globalThis.sessionFault='lost';if(response.status!==200)throw new Error('refresh not committed');throw new Error('lost committed response')}
        if(route.endsWith('/auth/refresh')&&globalThis.sessionFault==='hold-refresh'){globalThis.sessionHeld=true;await new Promise(resolve=>{globalThis.releaseSession=resolve})}
        return response
      }
    },offline)
    return page
  }
  let page=await launch();await login(page)
  expect(await page.evaluate(async()=>(await import('/src/token.ts')).getAccessToken())).toBe('')
  const state=await page.evaluate(()=>window.erpDesktop.session.status());expect(state.mode).toBe('online');expect(state.persistent).toBe(true)
  expect(await page.evaluate(async()=>({cookies:document.cookie,refresh:await(await import('/src/offline/session.ts')).loadRefreshToken()}))).toMatchObject({refresh:null})
  expect((await electron.context().cookies()).some(item=>item.name==='mvs_refresh')).toBe(false)
  const vaultText=await fs.readFile(path.join(profile,'sessions.json'),'utf8');expect(vaultText).not.toMatch(/access_token|refresh_token|"password"/)
  report.push('DESKTOP PASS: OS-protected persistence; no tokens in renderer, IndexedDB or browser cookie jar')
  await electron.evaluate(({BrowserWindow},{web,preload})=>{
    const win=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}})
    globalThis.attachSessionFixture(win.webContents);void win.loadURL(web+'/projects')
  },{web,preload:fileURLToPath(new URL('../desktop/preload.js',import.meta.url))})
  await expect.poll(()=>electron.windows().length).toBe(2)
  const sibling=electron.windows().find(window=>window!==page);await expect(sibling.locator('.ah-burger')).toBeVisible()
  await electron.evaluate(()=>{globalThis.sessionCalls=[];globalThis.sessionFault='hold-refresh';globalThis.sessionHeld=false})
  const renewals=[page,sibling].map(tab=>tab.evaluate(()=>window.erpDesktop.session.refresh()))
  await expect.poll(()=>electron.evaluate(()=>globalThis.sessionHeld)).toBe(true)
  expect(await electron.evaluate(()=>globalThis.sessionCalls.filter(call=>call.route.endsWith('/auth/refresh')).length)).toBe(1)
  await electron.evaluate(()=>{globalThis.sessionFault=null;globalThis.releaseSession()});await Promise.all(renewals)
  report.push('DESKTOP PASS: two actual windows share one refresh owner')
  token=(await external('POST','/auth/login',{username:'admin',password})).access_token
  const stamp='Session-'+Date.now(), dates={start_date:'2026-11-01',end_date:'2026-12-31'}
  const project=await external('POST','/project',{title:stamp,code:'S'+Date.now(),owner_id:state.user.id,...dates})
  const processRow=await external('POST','/process',{title:stamp,project_id:project.id,owner_id:state.user.id,...dates})
  await page.goto(web+'/planner')
  await page.evaluate(async()=>{const store=await import('/src/store/index.ts');await store.usePlanningStore().refreshTaskPlanning(true)})
  await electron.evaluate(()=>{globalThis.sessionFault='offline'})
  expect(await page.evaluate(async processId=>{
    localStorage.setItem('mvs_erp_user', JSON.stringify({ id: 999999, username: 'forged-cached-user', preset: 'admin' }));
    (await import('/src/offline/state.ts')).isOffline.value=true
    return(await import('/src/store/index.ts')).usePlanningStore().createTask({title:'Session-offline-restart',process_id:processId,start_date:'2026-11-09',end_date:'2026-11-22'})
  },processRow.id)).toBe(true)
  expect(await page.evaluate(async()=>(await window.erpDesktop.queue.request({action:'list',contextId:(await window.erpDesktop.session.status()).contextId})).length)).toBe(1)
  expect((await page.evaluate(()=>window.erpDesktop.session.status())).user.username).toBe('admin')
  await electron.close();electron=null
  page=await launch(true);await page.goto(web+'/planner');await expect(page.locator('.ah-burger')).toBeVisible()
  expect((await page.evaluate(()=>window.erpDesktop.session.status())).mode).toBe('offline')
  expect(await page.evaluate(async()=>(await window.erpDesktop.queue.request({action:'list',contextId:(await window.erpDesktop.session.status()).contextId})).length)).toBe(1)
  await electron.evaluate(()=>{globalThis.sessionFault=null})
  const restored = await auth(page,'refreshSession')
  if (!restored) console.log('RECOVERY DIAGNOSTIC', await page.evaluate(async () => { const {useAuthStore}=await import('/src/store/index.ts'); const auth=useAuthStore(); return { session: await window.erpDesktop.session.status(), storage:(await import('/src/platform/state.ts')).localDataAvailability.value, authenticated:auth.isAuthenticated, mode:auth.sessionMode, error:auth.error } }))
  expect(restored).toBe(true)
  await page.evaluate(async()=>{const state=await import('/src/offline/state.ts');state.isOffline.value=false;await(await import('/src/offline/sync.ts')).syncNow()})
  expect(await page.evaluate(async()=>(await window.erpDesktop.queue.request({action:'list',contextId:(await window.erpDesktop.session.status()).contextId})).length)).toBe(0)
  report.push('DESKTOP PASS: full offline restart preserves profile and queued edit; reconnection delivers once')
  await electron.evaluate(()=>{globalThis.sessionFault='lose-refresh';globalThis.sessionCalls=[]})
  const uncertain=await page.evaluate(()=>window.erpDesktop.session.refresh());expect(uncertain.needsLogin).toBe(true);expect(uncertain.mode).toBe('offline')
  await page.evaluate(()=>window.erpDesktop.session.refresh())
  expect(await electron.evaluate(()=>globalThis.sessionCalls.filter(call=>call.route.endsWith('/auth/refresh')).length)).toBe(1)
  await electron.evaluate(()=>{globalThis.sessionFault=null});await login(page)
  report.push('DESKTOP PASS: lost committed refresh disables replay and recovers through manual login')
  const account=await external('POST','/user',{username:'ss'+Date.now(),preset:'worker',first_name:'Session',last_name:'Fixture'})
  await auth(page,'logout');await login(page,account.user.username,account.password)
  await external('DELETE','/user/'+account.user.id)
  const rejected=await page.evaluate(()=>window.erpDesktop.session.refresh());expect(rejected.mode).toBe('signedOut');expect(rejected.offlineAvailable).toBe(false)
  await expect(page.evaluate(()=>window.erpDesktop.session.enterOffline(null))).rejects.toThrow()
  report.push('DESKTOP PASS: deleted account is rejected by backend and cannot enter its cached profile')
  await external('DELETE','/project/'+project.id)
  expect(errors).toEqual([])
  console.log(JSON.stringify({cases:report.length,report},null,2))
}finally{
  if(electron)await electron.close()
  if(profile)await fs.rm(profile,{recursive:true,force:true})
  await browser.close().catch(()=>{})
}
