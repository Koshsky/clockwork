'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { fork } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { createStorage: storageFactory } = require('../desktop/storage.cjs')
const { openStorage: databaseFactory, restoreBackup, filename } = require('../desktop/storage-db.cjs')
const { applicationId, migrations } = require('../desktop/storage-schema.cjs')
const { storageFailure, safeJSON } = require('../desktop/storage-validation.cjs')
const resources = new Set()
async function createStorage(options) { const store = await storageFactory(options); resources.add({ directory: options.directory, store }); return store }
async function openStorage(directory, options) { const store = await databaseFactory(directory, options); resources.add({ directory, store }); return store }
async function cleanup(directory) {
  for (const resource of [...resources]) if (resource.directory === directory || resource.directory.startsWith(directory + path.sep)) { await resource.store.close(); resources.delete(resource) }
  await fs.rm(directory, { recursive: true, force: true })
}
const scope = { server: 'https://erp.example/api/v1', accountId: 7 }
const change = (data = { title: 'Local' }, expectedRevision = 0) => ({ domain: 'planning.tasks', key: 'default', data, expectedRevision })
const command = (operationId = 'op', changes = [change()]) => ({ operationId, operation: 'task.update', input: { id: 1, patch: { title: 'Local' } }, idempotencyKey: 'key-' + operationId, changes })
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-storage-'))
  const store = await createStorage({ directory, ...options })
  t.after(async () => { await store.close(); await cleanup(directory) })
  return { store, directory, repository: store.forScope(scope) }
}
async function historical(directory, version = 1) {
  const db = new DatabaseSync(path.join(directory, filename))
  for (const migration of migrations.slice(0, version)) {
    db.exec(migration.sql)
    db.prepare('INSERT INTO storage_migrations VALUES(?,?,?,?)').run(migration.version, migration.name, migration.checksum, 1)
  }
  db.exec(`PRAGMA application_id=${applicationId};PRAGMA user_version=${version};`)
  db.close()
}

test('runtime uses built-in SQLite in a worker, WAL, FULL sync and versioned schema',async t=>{
  const {store}=await fixture(t)
  assert.equal(store.status().phase,'ready');assert.equal(store.status().driver,'node:sqlite');assert.equal(store.status().journalMode,'wal');assert.equal(store.status().synchronous,2);assert.equal(store.status().schemaVersion,2)
  assert.equal('directory' in store.status(),false)
})
test('local projection, command and durable queued receipt commit together',async t=>{
  const {repository}=await fixture(t)
  const result=await repository.commitLocal(command())
  assert.equal(result.status,'queued');assert.equal(result.replayed,false)
  assert.deepEqual((await repository.snapshot({domain:'planning.tasks'})).data,{title:'Local'})
  assert.equal((await repository.queue())[0].idempotencyKey,'key-op')
  assert.equal((await repository.receipt({operationId:'op'})).status,'queued')
})
test('restart preserves a queued command, projection and exact operation key',async t=>{
  const {store,directory,repository}=await fixture(t)
  await repository.commitLocal(command());await store.close()
  const restarted=await createStorage({directory});t.after(()=>restarted.close())
  const data=restarted.forScope(scope)
  assert.equal((await data.queue())[0].operationId,'op');assert.equal((await data.queue())[0].idempotencyKey,'key-op')
  assert.equal((await data.snapshot({domain:'planning.tasks'})).revision,1)
})
test('a duplicate intent returns its saved receipt without rewriting a newer projection',async t=>{
  const {repository}=await fixture(t)
  await repository.commitLocal(command());await repository.commitLocal(command('next',[change({title:'Newer'},1)]))
  assert.equal((await repository.commitLocal(command())).replayed,true)
  assert.equal((await repository.snapshot({domain:'planning.tasks'})).data.title,'Newer');assert.equal((await repository.queue()).length,2)
})
test('canonical intent hashing tolerates property ordering without duplicating work',async t=>{
  const {repository}=await fixture(t);const request=command();request.input.patch={title:'Local',color:'#fff'}
  await repository.commitLocal(request)
  assert.equal((await repository.commitLocal({...request,input:{patch:{color:'#fff',title:'Local'},id:1}})).replayed,true)
})
for(const mutation of [value=>({...value,input:{id:1,patch:{title:'Changed'}}}),value=>({...value,idempotencyKey:'different'}),value=>({...value,dependencies:['other']})])test('a reused operation id cannot change the durable intent',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command())
  await assert.rejects(repository.commitLocal(mutation(command())),{code:'STORAGE_OPERATION_REUSED'});assert.equal((await repository.queue()).length,1)
})
test('one idempotency key cannot refer to two different operations',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command())
  await assert.rejects(repository.commitLocal({...command('other',[]),idempotencyKey:'key-op'}),{code:'STORAGE_CONFLICT'})
  assert.equal((await repository.queue()).length,1)
})
test('stale projections roll back enqueue, scope creation and receipt as one transaction',async t=>{
  const {repository}=await fixture(t);await repository.saveSnapshot(change({title:'Current'}))
  await assert.rejects(repository.commitLocal(command()),{code:'STORAGE_STALE_REVISION'})
  assert.equal((await repository.snapshot({domain:'planning.tasks'})).data.title,'Current');assert.deepEqual(await repository.queue(),[]);assert.equal(await repository.receipt({operationId:'op'}),null)
})
test('failure on the second projection rolls back the first projection and its command',async t=>{
  const {repository}=await fixture(t)
  await assert.rejects(repository.commitLocal(command('op',[change(),{...change(),key:'other',expectedRevision:5}])),{code:'STORAGE_STALE_REVISION'})
  assert.equal(await repository.snapshot({domain:'planning.tasks'}),null);assert.deepEqual(await repository.queue(),[])
})
test('concurrent windows cannot both overwrite the same revision',async t=>{
  const {store,repository}=await fixture(t);const other=store.forScope(scope)
  const results=await Promise.allSettled([repository.commitLocal(command('first')),other.commitLocal(command('second'))])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'STORAGE_STALE_REVISION');assert.equal((await repository.queue()).length,1)
})
test('server canonicalization shares one namespace while accounts and servers stay isolated',async t=>{
  const {store,repository}=await fixture(t);await repository.commitLocal(command())
  const equivalent=store.forScope({server:'https://ERP.example:443/',accountId:7})
  assert.equal((await equivalent.queue()).length,1)
  for(const different of [{server:'https://another.example',accountId:7},{server:'http://erp.example',accountId:7},{server:'https://erp.example',accountId:8}]){
    const data=store.forScope(different);assert.deepEqual(await data.queue(),[]);assert.equal(await data.snapshot({domain:'planning.tasks'}),null);assert.equal(await data.receipt({operationId:'op'}),null)
  }
})
for(const value of [{server:'file:///tmp/x',accountId:7},{server:'https://u:p@host',accountId:7},{server:'https://erp.example?q=secret',accountId:7},{...scope,accountId:0},{...scope,accountId:'7'},{...scope,profile:'../other'}])test('invalid namespace cannot open another profile or identity',async t=>{
  const {store}=await fixture(t);assert.throws(()=>store.forScope(value))
})
test('the repository captures a normalized namespace instead of a mutable caller object',async t=>{
  const {store}=await fixture(t);const selected={...scope},repository=store.forScope(selected)
  selected.accountId=8;selected.server='https://another.example';await repository.commitLocal(command())
  assert.equal((await store.forScope(scope).queue()).length,1);assert.equal((await store.forScope(selected).queue()).length,0)
})
test('FIFO order and dependency readiness survive unknown responses and restarts',async t=>{
  const {store,directory,repository}=await fixture(t)
  await repository.commitLocal(command('parent',[]));await repository.commitLocal({...command('child',[]),dependencies:['parent']})
  assert.deepEqual((await repository.queue()).map(r=>[r.operationId,r.ready]),[['parent',true],['child',false]])
  await assert.rejects(repository.markAttempt({operationId:'child'}),{code:'STORAGE_DEPENDENCY_NOT_READY'})
  await repository.markAttempt({operationId:'parent'});await store.close()
  const next=await createStorage({directory});t.after(()=>next.close());const data=next.forScope(scope)
  assert.equal((await data.queue())[0].status,'unknown');assert.equal((await data.queue())[0].attempts,1)
  await data.settle({operationId:'parent',status:'confirmed',result:{id:10}})
  assert.equal((await data.queue())[0].operationId,'child');assert.equal((await data.queue())[0].ready,true)
})
test('dependencies cannot cross accounts, be missing, duplicated or form self cycles',async t=>{
  const {store,repository}=await fixture(t);await repository.commitLocal(command('parent',[]))
  await assert.rejects(store.forScope({...scope,accountId:8}).commitLocal({...command('child',[]),dependencies:['parent']}),{code:'STORAGE_MISSING_DEPENDENCY'})
  for(const dependencies of [['missing'],['op'],['parent','parent']])await assert.rejects(repository.commitLocal({...command(),dependencies}))
  assert.equal((await repository.queue()).length,1)
})
test('failed dependencies stay durable and cannot accidentally release dependent commands',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command('parent',[]));await repository.commitLocal({...command('child',[]),dependencies:['parent']})
  await repository.settle({operationId:'parent',status:'rejected',result:{reason:'Denied'}})
  assert.equal((await repository.queue())[0].status,'rejected');assert.equal((await repository.queue())[1].ready,false)
  await assert.rejects(repository.markAttempt({operationId:'parent'}),{code:'STORAGE_INVALID_TRANSITION'})
})
test('a background snapshot cannot erase a pending optimistic projection',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command())
  await assert.rejects(repository.saveSnapshot(change({title:'Stale server'},1)),{code:'STORAGE_PENDING_PROJECTION'})
  assert.equal((await repository.snapshot({domain:'planning.tasks'})).data.title,'Local')
})
test('settlement atomically stores receipt, id mapping and final projection',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command())
  await repository.settle({operationId:'op',status:'confirmed',result:{id:12},mappings:[{entity:'task',temporaryId:-5,realId:12}],changes:[change({id:12,title:'Server'},1)]})
  assert.equal(await repository.resolveId({entity:'task',temporaryId:-5}),12);assert.equal((await repository.snapshot({domain:'planning.tasks'})).data.id,12)
  assert.equal((await repository.receipt({operationId:'op'})).status,'confirmed');assert.deepEqual(await repository.queue(),[])
  await repository.saveSnapshot(change({title:'Later pull'},2))
})
test('a failed settlement rolls back mappings and receipt instead of losing the command',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command())
  await assert.rejects(repository.settle({operationId:'op',status:'confirmed',result:{id:12},mappings:[{entity:'task',temporaryId:-5,realId:12}],changes:[change({},10)]}),{code:'STORAGE_STALE_REVISION'})
  assert.equal(await repository.resolveId({entity:'task',temporaryId:-5}),null);assert.equal((await repository.receipt({operationId:'op'})).status,'queued');assert.equal((await repository.queue()).length,1)
})
test('receipts and id maps remain available after confirmation and restart',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command());await repository.settle({operationId:'op',status:'confirmed',result:{id:12},mappings:[{entity:'task',temporaryId:-5,realId:12}]});await store.close()
  const next=await createStorage({directory});t.after(()=>next.close());const data=next.forScope(scope)
  assert.equal(await data.resolveId({entity:'task',temporaryId:-5}),12);assert.equal((await data.receipt({operationId:'op'})).status,'confirmed')
  assert.equal((await data.commitLocal(command())).replayed,true)
})
test('conflicting id mappings cannot rewrite an existing temporary identity',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command('a',[]));await repository.settle({operationId:'a',status:'confirmed',mappings:[{entity:'task',temporaryId:-1,realId:10}]})
  await repository.commitLocal(command('b',[]));await assert.rejects(repository.settle({operationId:'b',status:'confirmed',mappings:[{entity:'task',temporaryId:-1,realId:11}]}),{code:'STORAGE_ID_MAPPING_CONFLICT'})
  assert.equal(await repository.resolveId({entity:'task',temporaryId:-1}),10);assert.equal((await repository.receipt({operationId:'b'})).status,'queued')
})
test('duplicate confirmation is harmless but cannot change the saved server result',async t=>{
  const {repository}=await fixture(t);await repository.commitLocal(command());const acknowledgement={operationId:'op',status:'confirmed',result:{id:10}}
  await repository.settle(acknowledgement);await repository.settle({...acknowledgement,changes:[change({title:'Do not replay'},99)]})
  assert.equal((await repository.snapshot({domain:'planning.tasks'})).data.title,'Local')
  await assert.rejects(repository.settle({...acknowledgement,result:{id:11}}),{code:'STORAGE_SETTLEMENT_REUSED'})
})
for(const operation of ['account.create','comment.create','rbac.upsertRule','template.save','sql','fetch'])test(`online-only or unknown operation is never stored: ${operation}`,async t=>{
  const {repository}=await fixture(t);await assert.rejects(repository.commitLocal({...command(),operation}));assert.deepEqual(await repository.queue(),[])
})
for(const key of ['password','password_hash','old_password','new_password','access_token','refresh_token','Authorization','JWT_SECRET_KEY'])test(`credentials cannot enter snapshots or settings: ${key}`,async t=>{
  const {repository}=await fixture(t)
  await assert.rejects(repository.saveSnapshot(change({nested:{[key]:'private'}})),{code:'STORAGE_SECRET_NOT_ALLOWED'})
  await assert.rejects(repository.saveSetting({key:'preferences',value:{[key]:'private'},expectedRevision:0}),{code:'STORAGE_SECRET_NOT_ALLOWED'})
  assert.equal(await repository.snapshot({domain:'planning.tasks'}),null)
})
test('settings are revisioned, persistent and isolated per server and account',async t=>{
  const {store,repository}=await fixture(t);assert.equal(await repository.setting({key:'calendar'}),null)
  await repository.saveSetting({key:'calendar',value:{unit:'week'},expectedRevision:0})
  await assert.rejects(repository.saveSetting({key:'calendar',value:{unit:'day'},expectedRevision:0}),{code:'STORAGE_STALE_REVISION'})
  assert.equal((await repository.setting({key:'calendar'})).value.unit,'week');assert.equal(await store.forScope({...scope,accountId:8}).setting({key:'calendar'}),null)
})
test('payload bounds reject oversized, cyclic and executable values before durable writes',()=>{
  const cycle={};cycle.self=cycle
  for(const value of [cycle,()=>{}, {text:'x'.repeat(65537)},JSON.parse('{"__proto__":{"x":1}}')])assert.throws(()=>safeJSON(value))
})
test('queue pagination is stable and never sweeps commands by age',async t=>{
  const {store,directory,repository}=await fixture(t)
  for(let index=0;index<3;index++)await repository.commitLocal(command('op-'+index,[]))
  await store.close();const old=new DatabaseSync(path.join(directory,filename));old.exec('UPDATE commands SET created_at=1,updated_at=1');old.close()
  const restarted=await createStorage({directory});const reader=restarted.forScope(scope)
  const first=await reader.queue({limit:2});assert.equal(first.length,2)
  assert.equal((await reader.queue({after:first[1].sequence,limit:2}))[0].operationId,'op-2')
  await assert.rejects(repository.queue({limit:201}));assert.equal((await reader.queue()).length,3)
})
test('read-only access rejects writes without modifying existing data',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command());await store.close()
  const reader=await createStorage({directory,readOnly:true});t.after(()=>reader.close());const data=reader.forScope(scope)
  assert.equal((await data.queue()).length,1);await assert.rejects(data.commitLocal(command('b',[])),{code:'STORAGE_READ_ONLY'})
})
test('a second writer cannot acquire the profile while its first worker owns it',async t=>{
  const {directory,repository}=await fixture(t);await repository.commitLocal(command())
  await assert.rejects(createStorage({directory}),{code:'STORAGE_BUSY'});assert.equal((await repository.queue()).length,1)
})
test('SQLITE_FULL rolls back the entire local change and remains an explicit error',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-full-'));t.after(()=>cleanup(directory))
  const db=await openStorage(directory,{configure:connection=>{const pages=connection.prepare('PRAGMA page_count').get().page_count;connection.exec('PRAGMA max_page_count='+(pages+1))}});t.after(()=>db.close())
  let failure
  try{db.commitLocal(scope,command('large',[change({text:'x'.repeat(60000)})]))}catch(error){failure=error}
  assert.equal(storageFailure(failure),'STORAGE_FULL');assert.deepEqual(db.queue(scope),[]);assert.equal(db.snapshot(scope,{domain:'planning.tasks'}),null)
})
test('corrupt storage fails closed and preserves the original bytes',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-corrupt-'));t.after(()=>cleanup(directory))
  const original=Buffer.from('This is not a SQLite database');await fs.writeFile(path.join(directory,filename),original)
  await assert.rejects(createStorage({directory}),{code:'STORAGE_CORRUPT'});assert.deepEqual(await fs.readFile(path.join(directory,filename)),original)
})
test('a foreign SQLite database is never adopted or cleared',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-foreign-'));t.after(()=>cleanup(directory))
  const db=new DatabaseSync(path.join(directory,filename));db.exec('CREATE TABLE foreign_data(value TEXT);INSERT INTO foreign_data VALUES(\'keep\')');db.close()
  await assert.rejects(createStorage({directory}),{code:'STORAGE_FOREIGN_DATABASE'})
  const check=new DatabaseSync(path.join(directory,filename));assert.equal(check.prepare('SELECT value FROM foreign_data').get().value,'keep');check.close()
})
test('a foreign SQLite database containing only a view is not adopted',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-foreign-view-'));t.after(()=>cleanup(directory))
  const db=new DatabaseSync(path.join(directory,filename));db.exec("CREATE VIEW foreign_data AS SELECT 'keep' value");db.close()
  await assert.rejects(createStorage({directory}),{code:'STORAGE_FOREIGN_DATABASE'})
  const check=new DatabaseSync(path.join(directory,filename));assert.equal(check.prepare('SELECT value FROM foreign_data').get().value,'keep');check.close()
})
test('a future schema is refused without downgrading or replacing its database',async t=>{
  const {store,directory}=await fixture(t);await store.close();const db=new DatabaseSync(path.join(directory,filename));db.exec('PRAGMA user_version=99');db.close()
  const bytes=await fs.readFile(path.join(directory,filename));await assert.rejects(createStorage({directory}),{code:'STORAGE_INCOMPATIBLE_VERSION'});assert.deepEqual(await fs.readFile(path.join(directory,filename)),bytes)
})
test('changed or missing migration history is refused instead of silently repaired',async t=>{
  const {store,directory}=await fixture(t);await store.close();const db=new DatabaseSync(path.join(directory,filename));db.exec("UPDATE storage_migrations SET checksum='tampered' WHERE version=1");db.close()
  await assert.rejects(createStorage({directory}),{code:'STORAGE_MIGRATION_MISMATCH'})
})
test('a historical schema is backed up and upgraded without losing its settings',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-upgrade-'));t.after(()=>cleanup(directory));await historical(directory)
  const old=new DatabaseSync(path.join(directory,filename));old.exec("INSERT INTO scopes VALUES(1,'https://erp.example/api/v1',7);INSERT INTO settings VALUES(1,'calendar','\"week\"',1)");old.close()
  const store=await createStorage({directory});t.after(()=>store.close());assert.equal(store.status().schemaVersion,2);assert.equal((await store.forScope(scope).setting({key:'calendar'})).value,'week')
  const files=await fs.readdir(path.join(directory,'backups'));assert.equal(files.filter(file=>file.startsWith('migration-')&&file.endsWith('.sqlite')).length,1)
})
test('backup captures committed snapshots, queued commands, receipts and id maps',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command('parent',[]));await repository.settle({operationId:'parent',status:'confirmed',mappings:[{entity:'task',temporaryId:-1,realId:10}]});await repository.commitLocal(command('pending'))
  const saved=await store.backup(),restored=path.join(directory,'restored');await restoreBackup(directory,saved.id,restored)
  const next=await createStorage({directory:restored});t.after(()=>next.close());const data=next.forScope(scope)
  assert.equal((await data.queue())[0].operationId,'pending');assert.equal((await data.snapshot({domain:'planning.tasks'})).data.title,'Local');assert.equal(await data.resolveId({entity:'task',temporaryId:-1}),10);assert.equal((await data.receipt({operationId:'parent'})).status,'confirmed')
})
test('restore cannot overwrite a profile, follow a symlink or select an arbitrary file',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command());const saved=await store.backup()
  await assert.rejects(restoreBackup(directory,saved.id,directory),{code:'STORAGE_RESTORE_TARGET_EXISTS'})
  for(const id of ['../clockwork.sqlite','/etc/passwd','missing.sqlite'])await assert.rejects(restoreBackup(directory,id,path.join(directory,'target')))
  assert.equal((await repository.queue()).length,1)
})
test('a backup remains consistent while later writes are queued behind its worker operation',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command('before',[]))
  const saving=store.backup(),write=repository.commitLocal(command('after',[]));const saved=await saving;await write
  const restored=path.join(directory,'restored');await restoreBackup(directory,saved.id,restored);const next=await createStorage({directory:restored});t.after(()=>next.close())
  assert.deepEqual((await next.forScope(scope).queue()).map(item=>item.operationId),['before']);assert.equal((await repository.queue()).length,2)
})
test('graceful shutdown drains accepted transactions and rejects later work',async t=>{
  const {store,directory,repository}=await fixture(t);const writes=Array.from({length:10},(_,i)=>repository.commitLocal(command('op-'+i,[])))
  const closing=store.close();await assert.rejects(repository.queue(),{code:'STORAGE_UNAVAILABLE'});await Promise.all(writes);assert.equal(await closing,true)
  const next=await createStorage({directory});t.after(()=>next.close());assert.equal((await next.forScope(scope).queue()).length,10)
})
test('shutdown drains a completely full request queue without dropping accepted writes',async t=>{
  const {store,directory,repository}=await fixture(t)
  const writes=Array.from({length:64},(_,index)=>repository.commitLocal(command('full-'+index,[])))
  const closing=store.close()
  await Promise.all(writes);assert.equal(await closing,true)
  const restarted=await createStorage({directory})
  assert.equal((await restarted.forScope(scope).queue()).length,64)
})
test('worker loss is explicit and does not create an empty replacement database',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command());await store.abort()
  assert.equal(store.status().phase,'failed');await assert.rejects(repository.queue(),{code:'STORAGE_UNAVAILABLE'})
  const next=await createStorage({directory});t.after(()=>next.close());assert.equal((await next.forScope(scope).queue()).length,1)
})
for(const phase of ['before','after'])test(`process death ${phase} COMMIT has an atomic, recoverable outcome`,{timeout:15000},async t=>{
  const {store,directory}=await fixture(t);await store.close()
  const child=fork(path.join(__dirname,'fixtures/storage-crash.cjs'),[JSON.stringify({directory,phase})],{execPath:process.execPath,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc']})
  t.after(()=>{if(child.exitCode==null)child.kill('SIGKILL')})
  await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('Crash fixture exited '+code)))})
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited
  const next=await createStorage({directory});t.after(()=>next.close());const data=next.forScope(scope),rows=await data.queue(),snapshot=await data.snapshot({domain:'planning.tasks'})
  assert.equal(rows.length,phase==='after'?1:0);assert.equal(snapshot?.data?.title??null,phase==='after'?'Committed':null)
  const retry={...command('crash-intent'),idempotencyKey:'crash-key',input:{id:1,patch:{title:'Committed'}},changes:[change({title:'Committed'})]}
  assert.equal((await data.commitLocal(retry)).replayed,phase==='after');assert.equal((await data.queue()).length,1)
})
test('profile settings survive reopening without inheriting another account preferences',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.saveSetting({key:'calendar',value:{unit:'week'},expectedRevision:0});await store.close()
  const next=await createStorage({directory});assert.deepEqual(await next.forScope(scope).setting({key:'calendar'}),{value:{unit:'week'},revision:1});assert.equal(await next.forScope({...scope,accountId:8}).setting({key:'calendar'}),null)
})
test('missing schema objects are treated as corruption and not silently recreated',async t=>{
  const {store,directory}=await fixture(t);await store.close();const db=new DatabaseSync(path.join(directory,filename));db.exec('DROP TABLE idmap');db.close()
  await assert.rejects(createStorage({directory}),{code:'STORAGE_CORRUPT'});const check=new DatabaseSync(path.join(directory,filename));assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name='idmap'").get(),undefined);check.close()
})
test('backup symlinks cannot redirect recovery outside the selected backup',async t=>{
  const {store,directory}=await fixture(t);await store.backup();const id='manual-00000000-0000-4000-8000-000000000000.sqlite'
  try{await fs.symlink(path.join(directory,filename),path.join(directory,'backups',id))}catch(error){if(error.code==='EPERM'){t.skip('OS does not grant symlink creation');return}throw error}
  await assert.rejects(restoreBackup(directory,id,path.join(directory,'restored')),{code:'STORAGE_INVALID_BACKUP'})
})
test('a database symlink is refused before opening another file',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-link-'));t.after(()=>cleanup(directory))
  const other=path.join(directory,'original');await fs.writeFile(other,'keep')
  try{await fs.symlink(other,path.join(directory,filename))}catch(error){if(error.code==='EPERM'){t.skip('OS does not grant symlink creation');return}throw error}
  await assert.rejects(createStorage({directory}),{code:'STORAGE_INVALID_FILE'});assert.equal(await fs.readFile(other,'utf8'),'keep')
})
test('a failed migration rolls back its DDL and history while retaining the pre-upgrade backup',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clockwork-migration-'));t.after(()=>cleanup(directory));await historical(directory)
  await assert.rejects(openStorage(directory,{onCommit:phase=>{if(phase==='before')throw new Error('interrupted migration')}}))
  const check=new DatabaseSync(path.join(directory,filename));assert.equal(check.prepare('PRAGMA user_version').get().user_version,1);assert.equal(check.prepare('SELECT count(*) count FROM storage_migrations').get().count,1);assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name='commands_pending'").get(),undefined);check.close()
  assert.equal((await fs.readdir(path.join(directory,'backups'))).filter(name=>name.endsWith('.sqlite')).length,1)
  const store=await createStorage({directory});assert.equal(store.status().schemaVersion,2)
})
test('worker request capacity is bounded without acknowledging rejected work',async t=>{
  const {repository}=await fixture(t)
  const results=await Promise.allSettled(Array.from({length:65},()=>repository.queue()))
  assert.equal(results.filter(item=>item.status==='fulfilled').length,64)
  assert.equal(results.find(item=>item.status==='rejected').reason.code,'STORAGE_BUSY')
})
test('SQLite lock contention blocks its worker, not the main event loop',async t=>{
  const {directory}=await fixture(t);let ticks=0
  const timer=setInterval(()=>ticks++,10)
  try{await assert.rejects(createStorage({directory}),{code:'STORAGE_BUSY'})}finally{clearInterval(timer)}
  assert.ok(ticks>5)
})
test('aborting an in-flight write reports unknown and recovers without a duplicate intent',async t=>{
  const {store,directory,repository}=await fixture(t)
  const pending=repository.commitLocal(command()).catch(error=>error.code);await store.abort();assert.equal(await pending,'STORAGE_OUTCOME_UNKNOWN')
  const next=await createStorage({directory});const data=next.forScope(scope),rows=await data.queue(),snapshot=await data.snapshot({domain:'planning.tasks'})
  assert.ok(rows.length===0||rows.length===1);assert.equal(Boolean(snapshot),rows.length===1)
  await data.commitLocal(command());assert.equal((await data.queue()).length,1)
})
test('an OS read-only database cannot be silently made writable or replaced',async t=>{
  if(process.getuid?.()===0){t.skip('Permission enforcement needs an unprivileged account');return}
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command());await store.close()
  const target=path.join(directory,filename),before=await fs.readFile(target);await fs.chmod(target,0o400)
  try{await assert.rejects(createStorage({directory}),error=>['STORAGE_READ_ONLY','STORAGE_CANNOT_OPEN'].includes(error.code));assert.deepEqual(await fs.readFile(target),before)}finally{await fs.chmod(target,0o600)}
})
for(const suffix of ['-wal','-shm'])test(`SQLite sidecar symlink ${suffix} cannot be followed or chmodded`,async t=>{
  const {store,directory}=await fixture(t);await store.close();const other=path.join(directory,'external');await fs.writeFile(other,'keep')
  try{await fs.symlink(other,path.join(directory,filename+suffix))}catch(error){if(error.code==='EPERM'){t.skip('OS does not grant symlink creation');return}throw error}
  await assert.rejects(createStorage({directory}),{code:'STORAGE_INVALID_FILE'});assert.equal(await fs.readFile(other,'utf8'),'keep')
})
test('an OS read-only profile cannot acknowledge writes or change its database',async t=>{
  if(process.platform==='win32'||process.getuid?.()===0){t.skip('Directory write modes need an unprivileged POSIX account');return}
  const {store,directory,repository}=await fixture(t);await repository.commitLocal(command());await store.close()
  const before=await fs.readFile(path.join(directory,filename));await fs.chmod(directory,0o500)
  try{await assert.rejects(createStorage({directory}),{code:'STORAGE_READ_ONLY'});assert.deepEqual(await fs.readFile(path.join(directory,filename)),before)}finally{await fs.chmod(directory,0o700)}
})
test('settings revisions cannot cross the safe integer boundary',async t=>{
  const {store,directory,repository}=await fixture(t);await repository.saveSetting({key:'calendar',value:'keep',expectedRevision:0});await store.close()
  const db=new DatabaseSync(path.join(directory,filename));db.prepare('UPDATE settings SET revision=?').run(Number.MAX_SAFE_INTEGER);db.close()
  const restarted=await createStorage({directory}),data=restarted.forScope(scope)
  await assert.rejects(data.saveSetting({key:'calendar',value:'changed',expectedRevision:Number.MAX_SAFE_INTEGER}),{code:'STORAGE_REVISION_LIMIT'})
  assert.deepEqual(await data.setting({key:'calendar'}),{value:'keep',revision:Number.MAX_SAFE_INTEGER})
})
test('a backup directory symlink cannot redirect backup writes into another folder',async t=>{
  const {store,directory}=await fixture(t);const other=path.join(directory,'external');await fs.mkdir(other)
  try{await fs.symlink(other,path.join(directory,'backups'),'dir')}catch(error){if(error.code==='EPERM'){t.skip('OS does not grant symlink creation');return}throw error}
  await assert.rejects(store.backup(),{code:'STORAGE_INVALID_BACKUP'});assert.deepEqual(await fs.readdir(other),[])
})
for(const key of ['refresh_token','mvs_erp_refresh_token'])test(`reserved credential setting key cannot persist a raw string: ${key}`,async t=>{
  const {repository}=await fixture(t);await assert.rejects(repository.saveSetting({key,value:'secret',expectedRevision:0}),{code:'STORAGE_SECRET_NOT_ALLOWED'})
})
