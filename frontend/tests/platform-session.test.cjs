'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createSessionService, normalizeServer } = require('../desktop/session-service.cjs')
const { createSessionVault } = require('../desktop/session-vault.cjs')
const { dispatch, valid } = require('../desktop/session-ipc.cjs')
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const jwt = offset => 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+offset, jti:crypto.randomUUID() })).toString('base64url') + '.signature'
const success = (id = 7, refresh = 'secret-refresh') => ({ data: { user: { id, username: 'user'+id, preset:'vp' }, access_token: jwt(3600), refresh_token: refresh }, error:{} })
const reply = (data, status = 200) => ({ status, text: async () => JSON.stringify(data) })
function fixture(options = {}) {
  const records = {}, calls = []
  const vault = {
    get: base => structuredClone(records[base] || {}),
    put: async (base, record) => { records[base] = structuredClone(record) },
    encrypt: async text => 'encrypted:' + text,
    decrypt: async text => text?.startsWith('encrypted:') ? text.slice(10) : null,
    ...options.vault,
  }
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) })
    if (options.fetch) return options.fetch(url, init, calls)
    if (url.endsWith('/health')) return reply({})
    if (url.endsWith('/auth/logout')) return reply({})
    return reply(success())
  }
  const service = createSessionService({ vault, fetch, now: options.now })
  return { service, vault, records, calls, async login() { await service.selectServer('https://erp.example'); return service.login('user7','password') } }
}
const api = (service, operation = 'GET /project') => ({ operation, contextId: service.status().contextId, requestId: crypto.randomUUID() })

test('normalizes a server without accepting credentials, paths, search, fragments or native protocols', () => {
  assert.equal(normalizeServer('https://ERP.example/api/v1/'), 'https://erp.example/api/v1')
  for (const value of ['file:///tmp/x','javascript:x','https://user:pass@erp.example','https://erp.example/path','https://erp.example?a=1','https://erp.example/#x']) assert.throws(() => normalizeServer(value))
})
test('empty profile cannot enter offline or access an API', async () => {
  const f=fixture(); await f.service.selectServer('https://erp.example')
  assert.throws(() => f.service.enterOffline('user7'))
  assert.equal((await f.service.api('window',api(f.service))).status,401)
  assert.equal(f.calls.length,0)
})
test('login publishes public identity only; neither state nor events contain credentials', async () => {
  const f=fixture(), events=[]; f.service.subscribe(state => events.push(state))
  const state=await f.login()
  assert.equal(state.mode,'online');assert.equal(state.user.id,7);assert.equal(state.persistent,true)
  for (const serialized of [JSON.stringify(state),JSON.stringify(events)]) { assert.ok(!serialized.includes('secret-refresh'));assert.ok(!serialized.includes('access_token'));assert.ok(!serialized.includes('password')) }
  assert.equal(f.records[state.server].cipher,'encrypted:secret-refresh')
  assert.equal(f.calls[0].credentials,'omit');assert.equal(f.calls[0].redirect,'error')
})
test('two windows, timer and wake coalesce one refresh and preserve account context', async () => {
  const wait=defer(); const f=fixture({ fetch: async url => url.endsWith('/auth/refresh') ? wait.promise : reply(success()) })
  const initial=await f.login(), first=f.service.refresh(), second=f.service.refresh()
  await tick();assert.equal(f.calls.filter(c=>c.url.endsWith('/auth/refresh')).length,1)
  wait.resolve(reply(success(7,'rotated-secret')))
  const results=await Promise.all([first,second]);assert.equal(results[0].contextId,initial.contextId)
  assert.equal(f.records[initial.server].cipher,'encrypted:rotated-secret')
})
for (const changeServer of [false, true]) test('an old refresh cannot hold or release the next identity refresh: server=' + changeServer, async () => {
  const old = defer(), current = defer()
  let account = 7, rotations = 0, first, next, joined
  const f = fixture({ fetch: async url => {
    if (url.endsWith('/auth/refresh')) return ++rotations === 1 ? old.promise : current.promise
    if (url.endsWith('/auth/login')) return reply(success(account, 'login-' + account))
    return reply({})
  } })
  try {
    await f.login(); first = f.service.refresh(); await tick()
    if (changeServer) await f.service.selectServer('https://second.example')
    else await f.service.logout()
    account = 8; await f.service.login('user8', 'password')
    next = f.service.refresh(); await tick()
    assert.equal(rotations, 2)
    old.resolve(reply(success(7, 'old-rotation'))); await first; await tick()
    joined = f.service.refresh(); await tick()
    assert.equal(rotations, 2)
    current.resolve(reply(success(8, 'new-rotation'))); await Promise.all([next, joined])
    assert.equal(f.service.status().user.id, 8)
    assert.equal(f.records[f.service.status().server].cipher, 'encrypted:new-rotation')
    assert.ok(f.calls.some(call => call.url === 'https://erp.example/api/v1/auth/logout' && call.body?.refresh_token === 'old-rotation'))
  } finally {
    old.resolve(reply(success(7))); current.resolve(reply(success(8)))
    await Promise.allSettled([first, next, joined].filter(Boolean)); f.service.stop()
  }
})

test('Windows vault persistence does not require opening a directory descriptor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-vault-windows-'))
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform'), open = fs.open
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    fs.open = async function (filename, ...args) {
      if (filename === dir && args[0] === 'r') throw Object.assign(new Error('directory handles are unavailable'), { code: 'EPERM' })
      return open.call(this, filename, ...args)
    }
    const vault = createSessionVault(dir, {})
    await vault.put('https://erp.example', { user: { id: 7 }, cipher: 'encrypted', eligible: true })
    const reopened = createSessionVault(dir, {}); await reopened.load()
    assert.equal(reopened.get('https://erp.example').cipher, 'encrypted')
  } finally {
    fs.open = open; Object.defineProperty(process, 'platform', descriptor)
    await fs.rm(dir, { recursive: true, force: true })
  }
})
test('refresh persists an uncertainty marker before sending and never replays after lost response', async () => {
  let f;f=fixture({ fetch: async url => {
    if (url.endsWith('/auth/refresh')) {assert.equal(f.records['https://erp.example/api/v1'].cipher,undefined);throw new Error('response lost after commit')}
    return reply(success())
  } })
  await f.login();await f.service.refresh();await f.service.refresh()
  assert.equal(f.calls.filter(c=>c.url.endsWith('/auth/refresh')).length,1)
  assert.equal(f.service.status().needsLogin,true);assert.equal(f.service.status().offlineAvailable,true)
  assert.equal(f.service.enterOffline('user7').mode,'offline')
})
test('unreachable health leaves the durable credential untouched', async () => {
  const f=fixture({fetch: async url=>{if(url.endsWith('/health'))throw new Error('offline');return reply(success())}})
  await f.login();await f.service.refresh()
  assert.equal(f.calls.filter(c=>c.url.endsWith('/auth/refresh')).length,0)
  assert.equal(f.records['https://erp.example/api/v1'].cipher,'encrypted:secret-refresh')
})
test('offline restart restores only the previously verified account', async () => {
  const f=fixture();await f.login()
  const restored=createSessionService({vault:f.vault,fetch:async()=>{throw new Error('offline')}})
  await restored.selectServer('https://erp.example');await restored.refresh()
  assert.equal(restored.enterOffline('user7').mode,'offline')
  assert.throws(()=>restored.enterOffline('user8'))
  await restored.selectServer('https://another.example');assert.throws(()=>restored.enterOffline('user7'))
})
test('logout remains final across an offline restart and retains no reusable credential', async () => {
  const f=fixture();await f.login();await f.service.logout()
  assert.equal(f.service.status().mode,'signedOut');assert.equal(f.records['https://erp.example/api/v1'].cipher,undefined)
  const next=createSessionService({vault:f.vault,fetch:async()=>reply(success())})
  await next.selectServer('https://erp.example');assert.throws(()=>next.enterOffline('user7'));await next.refresh();assert.equal(next.status().mode,'signedOut')
})
for (const status of [401,403]) test(`server rejection ${status} removes offline eligibility and cannot be bypassed locally`,async()=>{
  const f=fixture({fetch:async url=>url.endsWith('/auth/refresh')?reply({error:{code:'INVALID_TOKEN'}},status):reply(success())})
  await f.login();await f.service.refresh();assert.equal(f.service.status().mode,'signedOut');assert.throws(()=>f.service.enterOffline('user7'))
})
test('logout during a late refresh never resurrects identity or its encrypted token',async()=>{
  const wait=defer(),f=fixture({fetch:async url=>url.endsWith('/auth/refresh')?wait.promise:reply(success())})
  await f.login();const refresh=f.service.refresh();await tick();await f.service.logout();wait.resolve(reply(success(7,'late-refresh')));await refresh
  assert.equal(f.service.status().mode,'signedOut');assert.equal(f.records['https://erp.example/api/v1'].cipher,undefined)
  await tick();assert.ok(f.calls.some(call=>call.body?.refresh_token==='late-refresh'&&call.url.endsWith('/auth/logout')))
})
test('an older login cannot overwrite a later login',async()=>{
  const first=defer();let count=0
  const f=fixture({fetch:async url=>url.endsWith('/auth/login')&&++count===1?first.promise:reply(success(8,'user8-refresh'))})
  await f.service.selectServer('https://erp.example');const pending=f.service.login('user7','password');await tick()
  await f.service.login('user8','password');first.resolve(reply(success()));await pending
  assert.equal(f.service.status().user.id,8);assert.equal(f.records['https://erp.example/api/v1'].user.id,8)
})
test('server switch discards a late login without sending its token to the next server',async()=>{
  const wait=defer(),f=fixture({fetch:async url=>url.endsWith('/auth/login')?wait.promise:reply({})})
  await f.service.selectServer('https://first.example');const login=f.service.login('user7','password');await tick()
  await f.service.selectServer('https://second.example');wait.resolve(reply(success()));await login
  assert.equal(f.service.status().user,null);assert.equal(f.service.status().server,'https://second.example/api/v1')
  assert.ok(f.calls.every(call=>call.url.startsWith('https://first.example')))
})
test('an unavailable OS secret store permits an ephemeral session without plaintext fallback',async()=>{
  const f=fixture({vault:{encrypt:async()=>null}});const state=await f.login()
  assert.equal(state.mode,'online');assert.equal(state.persistent,false);assert.equal(f.records[state.server].cipher,null)
  assert.ok(!JSON.stringify(f.records).includes('secret-refresh'))
})
test('vault write failure occurs before refresh consumption',async()=>{
  const f=fixture();await f.login();f.vault.put=async()=>{throw new Error('disk full')}
  await assert.rejects(f.service.refresh());assert.equal(f.calls.filter(c=>c.url.endsWith('/auth/refresh')).length,0)
})
test('API route injects its own credential, language, view filter and mutation key',async()=>{
  const f=fixture({fetch:async url=>url.endsWith('/project/9')?reply({data:{id:9},error:{}}):reply(success())});await f.login()
  const response=await f.service.api('window',{...api(f.service,'PUT /project/{id}'),path:{id:'9'},body:{name:'Updated'},key:'operation-1',locale:'en',viewUser:7})
  assert.equal(response.status,200);assert.equal(response.data.data.id,9)
  const last=f.calls.at(-1);assert.equal(last.headers['Idempotency-Key'],'operation-1');assert.equal(last.headers['X-View-User-ID'],'7');assert.equal(last.headers['Accept-Language'],'en');assert.ok(last.headers.Authorization.startsWith('Bearer '))
})
test('API rejects unknown operations, path traversal and unauthorized query fields',async()=>{
  const f=fixture();await f.login()
  for(const request of [{operation:'POST /auth/refresh'},{operation:'GET https://evil.example'},{operation:'GET /project/{id}',path:{id:'../auth/refresh'}},{operation:'GET /project',query:{arbitrary:'x'}}]) await assert.rejects(f.service.api('window',{...api(f.service),...request}))
  assert.equal(f.calls.length,1)
})
test('a stale account context cannot dispatch API operations',async()=>{
  const f=fixture();await f.login();const request=api(f.service);await f.service.logout();await f.login()
  await assert.rejects(f.service.api('window',request))
})
test('401 API response rotates once and retries with the same mutation id',async()=>{
  let attempts=0
  const f=fixture({fetch:async url=>url.endsWith('/project')?reply({},++attempts===1?401:200):reply(success(7,attempts?'new-refresh':'secret-refresh'))});await f.login()
  assert.equal((await f.service.api('window',{...api(f.service,'POST /project'),body:{name:'Project'},key:'operation-key'})).status,200)
  const writes=f.calls.filter(c=>c.url.endsWith('/project'));assert.equal(writes.length,2);assert.ok(writes.every(c=>c.headers['Idempotency-Key']==='operation-key'))
})
test('renderer closure aborts its reads but preserves accepted writes',async()=>{
  const waits=[],f=fixture({fetch:async(url,init)=>{
    if(url.endsWith('/project')) {const wait=defer();waits.push({wait,init});return wait.promise}return reply(success())
  }});await f.login()
  const read=f.service.api('first',api(f.service)),write=f.service.api('first',{...api(f.service,'POST /project'),body:{name:'P'}})
  await tick();f.service.detach('first');assert.equal(waits[0].init.signal.aborted,true);assert.equal(waits[1].init.signal.aborted,false)
  waits.forEach(item=>item.wait.resolve(reply({})));await Promise.all([read,write])
})
test('bounded session IPC rejects extra auth/URL/native fields and malformed requests',async()=>{
  for(const request of [null,[],{action:'__proto__'},{action:'status',refresh_token:'x'},{action:'api',operation:'GET /project',contextId:'c',requestId:'r',url:'https://evil.example'},{action:'login',username:'u',password:'x'.repeat(65537)},{action:'login',username:'u',password:()=>{}}]) assert.equal(valid(request),false)
  const result=await dispatch({status:()=>({server:'https://erp.example/api/v1'}),login:async()=>{throw new Error('Authorization: secret')}},'window',{action:'login',username:'u',password:'p',server:'https://erp.example/api/v1'})
  assert.deepEqual(result,{ok:false,error:'SESSION_UNAVAILABLE'})
})
test('login IPC refuses stale or missing server binding before sending credentials',async()=>{
  const f=fixture()
  const first=await f.service.selectServer('https://first.example')
  await f.service.selectServer('https://second.example')
  const request={action:'login',username:'user7',password:'password'}
  assert.deepEqual(await dispatch(f.service,'first',request),{ok:false,error:'SESSION_INVALID_REQUEST'})
  assert.deepEqual(await dispatch(f.service,'first',{...request,server:first.server}),{ok:false,error:'SESSION_CONTEXT_CHANGED'})
  assert.equal(f.calls.length,0)
  const result=await dispatch(f.service,'second',{...request,server:f.service.status().server})
  assert.equal(result.ok,true)
  assert.equal(f.calls.length,1)
  assert.ok(f.calls[0].url.startsWith('https://second.example/'))
})
test('real vault uses OS encryption, atomic private storage and survives reopening',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-session-'))
  const osStorage={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async text=>Buffer.from([...text].reverse().join('')),decryptStringAsync:async buffer=>({result:[...buffer.toString()].reverse().join('')})}
  try {
    const vault=createSessionVault(dir,osStorage);await vault.load();const cipher=await vault.encrypt('private-refresh')
    await vault.put('https://erp.example',{user:{id:7},cipher,eligible:true})
    const text=await fs.readFile(path.join(dir,'sessions.json'),'utf8');assert.ok(!text.includes('private-refresh'));assert.equal((await fs.stat(path.join(dir,'sessions.json'))).mode&0o777,0o600)
    const reopened=createSessionVault(dir,osStorage);await reopened.load();assert.equal(await reopened.decrypt(reopened.get('https://erp.example').cipher),'private-refresh')
  } finally {await fs.rm(dir,{recursive:true,force:true})}
})
test('Linux basic_text is rejected even when Electron reports encryption available',async()=>{
  const vault=createSessionVault('/unused',{getSelectedStorageBackend:()=> 'basic_text',isEncryptionAvailable:()=>true,encryptString:()=>{throw new Error('must not call')}})
  assert.equal(await vault.encrypt('secret'),null);assert.equal(await vault.decrypt('cipher'),null)
})
test('vault cannot silently replace corrupt or unsupported credentials',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-session-'))
  try {for(const text of ['{broken','{"version":99,"servers":{}}']) {await fs.writeFile(path.join(dir,'sessions.json'),text);await assert.rejects(createSessionVault(dir,{}).load())}}finally{await fs.rm(dir,{recursive:true,force:true})}
})
test('a process restart after uncertain rotation never loads or resends an old credential',async()=>{
  const f=fixture({fetch:async url=>{if(url.endsWith('/auth/refresh'))throw new Error('lost response');return reply(success())}})
  await f.login();await f.service.refresh();let calls=0
  const next=createSessionService({vault:f.vault,fetch:async()=>{calls++;return reply(success())}})
  await next.selectServer('https://erp.example');await next.refresh()
  assert.equal(calls,0);assert.equal(next.status().needsLogin,true);assert.equal(next.enterOffline('user7').user.id,7)
})
test('failure to persist a newly rotated credential cannot replay the previous one',async()=>{
  const f=fixture();await f.login();const write=f.vault.put
  f.vault.put=async(base,record)=>{if(record.cipher)throw new Error('disk full after rotation');await write(base,record)}
  await f.service.refresh();await f.service.refresh()
  assert.equal(f.calls.filter(call=>call.url.endsWith('/auth/refresh')).length,1)
  assert.equal(f.records['https://erp.example/api/v1'].cipher,undefined);assert.equal(f.service.status().needsLogin,true)
})
test('a refresh cannot silently switch to another account returned by a malformed server',async()=>{
  const f=fixture({fetch:async url=>reply(success(url.endsWith('/auth/refresh')?8:7))});await f.login();await f.service.refresh()
  assert.equal(f.service.status().user.id,7);assert.equal(f.service.status().mode,'offline');assert.equal(f.service.status().needsLogin,true)
})
test('token expiry after sleep joins the same main refresh as concurrent window requests',async()=>{
  const wait=defer(),f=fixture({now:()=>Date.now()+7200000,fetch:async url=>url.endsWith('/auth/refresh')?wait.promise:reply(success())})
  await f.login();const awake=f.service.tick(),window=f.service.refresh();await tick()
  assert.equal(f.calls.filter(call=>call.url.endsWith('/auth/refresh')).length,1)
  wait.resolve(reply(success(7,'after-wake')));await Promise.all([awake,window])
})
test('string route identifiers preserve RBAC preset editing without becoming arbitrary paths',async()=>{
  const f=fixture();await f.login()
  await f.service.api('window',{...api(f.service,'PUT /rbac/presets/{tag}'),path:{tag:'custom_role'},body:{name:'Custom'}})
  assert.ok(f.calls.at(-1).url.endsWith('/rbac/presets/custom_role'))
  for(const tag of ['..','../policies','x/y','x?delete=true'])await assert.rejects(f.service.api('window',{...api(f.service,'DELETE /rbac/presets/{tag}'),path:{tag}}))
})
test('an unresponsive OS key provider cannot hang login or fall back to plaintext',async()=>{
  const never=new Promise(()=>{})
  const unavailable=createSessionVault('/unused',{isAsyncEncryptionAvailable:()=>never},{timeoutMs:5})
  assert.equal(await unavailable.encrypt('private-token'),null)
  const blocked=createSessionVault('/unused',{isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:()=>never,decryptStringAsync:()=>never},{timeoutMs:5})
  assert.equal(await blocked.encrypt('private-token'),null);assert.equal(await blocked.decrypt('cipher'),null)
})
test('a late native transport failure after logout is cancellation, never a mutation under the next account',async()=>{
  const wait=defer(),f=fixture({fetch:async url=>url.endsWith('/project')?wait.promise:reply(success())});await f.login()
  const pending=f.service.api('window',{...api(f.service,'POST /project'),body:{title:'old-account'}})
  await tick();await f.service.logout();wait.reject(new Error('connection lost'))
  await assert.rejects(pending,{message:'SESSION_CONTEXT_CHANGED'})
})

test('native queue storage codes stay explicit without leaking native exception details', async () => {
  const { dispatch } = require('../desktop/session-ipc.cjs')
  const session = { api: async () => { throw Object.assign(new Error('/private/profile/clockwork.sqlite'), { code: 'STORAGE_FULL' }) } }
  const result = await dispatch(session, 'owner', { action: 'api', operation: 'POST /task', contextId: 'context', requestId: 'request' })
  assert.deepEqual(result, { ok: false, error: 'STORAGE_FULL' }); assert.equal(JSON.stringify(result).includes('/private'), false)
})
test('renderer cannot supply private durable delivery or revision switches', () => {
  const { valid } = require('../desktop/session-ipc.cjs')
  const base = { action: 'api', operation: 'PUT /task/{id}', contextId: 'context', requestId: 'request' }
  assert.equal(valid({ ...base, operationId: 'bypass' }), false); assert.equal(valid({ ...base, revisionProtocol: true }), false)
})
