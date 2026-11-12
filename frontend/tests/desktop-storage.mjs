import { _electron, expect } from 'playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (!process.env.ELECTRON_EXECUTABLE) throw new Error('A native Electron executable is required')
const root=await mkdtemp(path.join(os.tmpdir(),'clockwork-native-storage-')),profile=path.join(root,'profile'),web=path.join(root,'web')
await mkdir(web);await writeFile(path.join(web,'index.html'),'<!doctype html><title>Storage fixture</title><main>Storage fixture</main>')
const main=fileURLToPath(new URL('./fixtures/storage-application.cjs',import.meta.url)),report=[]
let app
async function launch(port=0){const env={...process.env,ERP_STORAGE_PROFILE:profile,ERP_STORAGE_WEB:web,ERP_STORAGE_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;return _electron.launch({executablePath:process.env.ELECTRON_EXECUTABLE,args:[main],env})}
async function state(page){await page.waitForURL(/127\.0\.0\.1/);await page.waitForFunction(()=>window.erpDesktop?.service);return page.evaluate(()=>window.erpDesktop.service.status())}
async function read(page){return page.evaluate(async()=>{const bridge=window.erpDesktop.service,current=await bridge.status();return bridge.read({requestId:crypto.randomUUID(),contextId:current.context.id,operation:'planning.tasks',source:'snapshot'})})}
async function edit(page){return page.evaluate(async()=>{const bridge=window.erpDesktop.service,current=await bridge.status();return bridge.execute({requestId:crypto.randomUUID(),contextId:current.context.id,operationId:'native-stable-operation',operation:'task.update',input:{id:1,patch:{title:'Durably saved'}}})})}
try{
  app=await launch();const first=await app.firstWindow(),initial=await state(first),origin=new URL(first.url()).origin
  expect(initial.storage).toMatchObject({phase:'ready',driver:'node:sqlite',schemaVersion:2,journalMode:'wal',synchronous:2})
  expect(await first.evaluate(()=>({require:typeof window.require,storage:'storage' in window.erpDesktop,sql:'sql' in window.erpDesktop}))).toEqual({require:'undefined',storage:false,sql:false})
  expect(JSON.stringify(initial.storage)).not.toContain(profile)
  report.push('PASS production startup owns one isolated SQLite worker; renderer gets metadata without SQL, handles or paths')
  expect((await edit(first)).status).toBe('queued')
  expect((await read(first)).data.processes[0].tasks[0].title).toBe('Durably saved')
  const secondReady=app.waitForEvent('window');await app.evaluate(()=>storageApplication.createWindow());const second=await secondReady;await state(second)
  expect((await edit(second)).status).toBe('queued')
  expect(await app.evaluate(()=>storageApplication.storage.forScope({server:'https://erp.example/api/v1',accountId:7}).queue().then(rows=>rows.length))).toBe(1)
  report.push('PASS two real windows share atomic projection, queued intent and persistent same-key receipt')
  await first.close();expect((await read(second)).data.processes[0].tasks[0].title).toBe('Durably saved')
  report.push('PASS closing the originating window preserves durable work for its sibling')
  await app.close();app=null
  app=await launch(Number(new URL(origin).port)===65535?31880:Number(new URL(origin).port)+1)
  const restored=await app.firstWindow(),next=await state(restored)
  expect(new URL(restored.url()).origin).not.toBe(origin);expect(next.profileId).toBe(initial.profileId);expect(next.instanceId).not.toBe(initial.instanceId)
  expect((await read(restored)).data.processes[0].tasks[0].title).toBe('Durably saved');expect((await edit(restored)).status).toBe('queued')
  expect(await app.evaluate(()=>storageApplication.storage.forScope({server:'https://erp.example/api/v1',accountId:7}).queue().then(rows=>rows.length))).toBe(1)
  report.push('PASS full application restart and port change preserve data and deduplicate a lost-acknowledgement retry')
  await app.evaluate(()=>storageApplication.service.setScope({server:'https://another.example/api/v1',accountId:7}))
  expect((await read(restored)).status).toBe('missing')
  await app.evaluate(()=>storageApplication.service.setScope({server:'https://erp.example/api/v1',accountId:8}))
  expect((await read(restored)).status).toBe('missing')
  await app.evaluate(()=>storageApplication.service.setScope({server:'https://erp.example/api/v1',accountId:7}))
  expect((await read(restored)).status).toBe('ok')
  report.push('PASS main-authorized account/server changes expose only their own SQLite namespace')
  console.log(JSON.stringify({cases:report.length,report},null,2))
}finally{if(app)await app.close();await rm(root,{recursive:true,force:true})}
