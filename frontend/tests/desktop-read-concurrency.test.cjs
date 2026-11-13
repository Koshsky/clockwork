'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { createStorage } = require('../desktop/storage.cjs')
const { createCommandQueue } = require('../desktop/command-queue.cjs')
const base = 'https://read-cas.example/api/v1'
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const reply = data => ({ status: 200, data: { data, error: {} } })
const plan = title => ({ processes: [{ id: 10, project_id: 20, tasks: [{ id: 30, process_id: 10, title, resources: [] }], milestones: [] }] })
async function fixture(t) {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-read-cas-')), storage = await createStorage({ directory })
 const state = { server: base, user: { id: 7 }, mode: 'offline', contextId: 'first' }, listeners = new Set()
 const session = { status: () => structuredClone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
 let queueHook = null
 const selectedStorage = { ...storage, forScope(scope) { const repository = storage.forScope(scope); return { ...repository, queue(params) { return queueHook ? queueHook(() => repository.queue(params)) : repository.queue(params) } } } }
 const queue = createCommandQueue({ storage: selectedStorage, session, rateMs: 0, acknowledgementMs: 0 }); queue.installPull({ observe() {} })
 t.after(async () => { await queue.stop(); await storage.close(); await fs.rm(directory, { recursive: true, force: true }) })
 const repo = storage.forScope({ server: base, accountId: 7 })
 return { queue, repo, pauseQueueRead() { const entered = defer(), release = defer(); queueHook = async next => { queueHook = null; entered.resolve(); await release.promise; return next() }; return { entered: entered.promise, release: release.resolve } }, async cached(key) { return queue.control({ action: 'cacheGet', key: base + key }) }, switchAccount() { state.contextId = 'second'; state.user.id = 8; for (const listener of listeners) listener() } }
}
function held(queue, operation, input = {}) {
 const response = defer(), started = defer()
 const promise = queue.api({ operation, ...input }, () => { started.resolve(); return response.promise })
 promise.catch(() => {})
 return { promise, started: started.promise, finish: response.resolve }
}
const title = result => result.data.data.processes[0].tasks[0].title
async function seed(f, value = 'Before') { await f.queue.cachePut(base + '/planning/tasks', { ts: 1, data: reply(plan(value)).data }, { 'process:10': 'v1' }) }
test('parallel cold reads for unrelated keys all commit without invalidating one another', async t => {
 const f = await fixture(t)
 const reads = Array.from({ length: 6 }, (_, i) => held(f.queue, 'GET /task/{id}/comments', { path: { id: String(i + 1) } }))
 await Promise.all(reads.map(read => read.started))
 for (const [i, read] of reads.entries()) read.finish(reply([{ id: i + 1, content: 'Comment ' + i }]))
 const results = await Promise.all(reads.map(read => read.promise))
 assert.deepEqual(results.map(row => row.data.data[0].content), Array.from({ length: 6 }, (_, i) => 'Comment ' + i))
 assert.equal((await f.repo.cacheKeys()).length, 6)
})
for (const newerFirst of [false, true]) test('overlapping same-key reads keep the newer request: newerFirst=' + newerFirst, async t => {
 const f = await fixture(t), a = held(f.queue, 'GET /planning/tasks'), b = held(f.queue, 'GET /planning/tasks')
 await Promise.all([a.started, b.started])
 if (newerFirst) { b.finish(reply(plan('Newer'))); await b.promise; a.finish(reply(plan('Older'))) }
 else { a.finish(reply(plan('Older'))); await a.promise; b.finish(reply(plan('Newer'))) }
 await Promise.all([a.promise, b.promise])
 assert.equal(title(await f.cached('/planning/tasks')), 'Newer')
 if (newerFirst) assert.equal(title(await a.promise), 'Newer')
})
test('a read begun before a local intent cannot remove its projection or lend a new baseline', async t => {
 const f = await fixture(t); await seed(f)
 const read = held(f.queue, 'GET /planning/tasks'); await read.started
 await f.queue.submit({ operationId: 'local-edit', input: { route: 'PUT /task/{id}', path: { id: '30' }, query: {}, body: { title: 'Local' }, preconditions: { 'process:10': 'v1' } } })
 read.finish(reply(plan('Stale server')))
 const result = await read.promise
 assert.equal(title(result), 'Local'); assert.deepEqual(result.baseline, { 'process:10': 'local:local-edit' })
 const command = (await f.queue.control({ action: 'list' }))[0]
 assert.equal(command.operationId, 'local-edit'); assert.deepEqual(command.input.preconditions, { 'process:10': 'v1' })
 assert(!JSON.stringify(result).includes('_confirmed'))
})
test('a completed atomic pull takes precedence over a held foreground response', async t => {
 const f = await fixture(t); await seed(f)
 const read = held(f.queue, 'GET /planning/tasks'); await read.started
 await f.queue.commitPull([{ key: base + '/planning/tasks', value: { ts: 2, data: reply(plan('Pulled')).data }, revisions: { 'process:10': 'v2' } }], f.queue.status().mutationRevision)
 read.finish(reply(plan('Old GET')))
 const result = await read.promise
 assert.equal(title(result), 'Pulled'); assert.deepEqual(result.baseline, { 'process:10': 'v2' })
})
test('permission revocation also fences pending cold keys which did not exist during invalidation', async t => {
 const f = await fixture(t), read = held(f.queue, 'GET /task/{id}/comments', { path: { id: '7' } }); await read.started
 await f.queue.api({ operation: 'GET /permissions/me' }, async () => reply([]))
 read.finish(reply([{ id: 1, content: 'Previously accessible' }]))
 await assert.rejects(read.promise, /COMMAND_SNAPSHOT_CHANGED/)
 assert.equal(await f.cached('/task/7/comments'), undefined)
})
for (const newerFirst of [false, true]) test('overlapping permission changes keep the newest rights: newerFirst=' + newerFirst, async t => {
 const f = await fixture(t); await seed(f)
 const a = held(f.queue, 'GET /permissions/me'), b = held(f.queue, 'GET /permissions/me'); await Promise.all([a.started, b.started])
 if (newerFirst) { b.finish(reply([])); await b.promise; a.finish(reply([{ resource: 'task', action: 'view', scope: 'all' }])) }
 else { a.finish(reply([{ resource: 'task', action: 'view', scope: 'all' }])); await a.promise; b.finish(reply([])) }
 await Promise.all([a.promise, b.promise]); assert.deepEqual((await f.cached('/permissions/me')).data.data, [])
 assert.equal((await f.cached('/planning/tasks')).status, 403)
})
for (const status of [403, 404]) test('late ' + status + ' cannot replace a newer successful snapshot', async t => {
 const f = await fixture(t); await seed(f)
 const old = held(f.queue, 'GET /planning/tasks'); await old.started
 await f.queue.api({ operation: 'GET /planning/tasks' }, async () => reply(plan('Current')))
 old.finish({ status, data: { data: null, error: { code: 'REFUSED' } } })
 const result = await old.promise; assert.equal(result.status, 200); assert.equal(title(result), 'Current')
})
test('old-scope completion writes neither the old nor the replacement account', async t => {
 const f = await fixture(t), old = held(f.queue, 'GET /planning/tasks'); await old.started
 f.switchAccount(); old.finish(reply(plan('Old account')))
 await assert.rejects(old.promise, /SESSION_CONTEXT_CHANGED/)
 assert.equal((await f.repo.cacheKeys()).length, 0); assert.equal(await f.cached('/planning/tasks'), undefined)
})
test('read cohorts are bounded and completed cohorts release capacity', { timeout: 15000 }, async t => {
 const f = await fixture(t), reads = Array.from({ length: 64 }, (_, i) => held(f.queue, 'GET /task/{id}/comments', { path: { id: String(i + 1) } }))
 await Promise.all(reads.map(row => row.started))
 await assert.rejects(f.queue.api({ operation: 'GET /task/{id}/comments', path: { id: '100' } }, async () => reply([])), /COMMAND_BUSY/)
 for (const read of reads) read.finish(reply([]))
 await Promise.all(reads.map(row => row.promise))
 for (let id = 100; id < 180; id++) await f.queue.api({ operation: 'GET /task/{id}/comments', path: { id: String(id) } }, async () => reply([]))
 assert.equal((await f.repo.cacheKeys()).length, 144)
})
test('stopping the service cannot publish an outstanding foreground reply', async t => {
 const f = await fixture(t), read = held(f.queue, 'GET /planning/tasks'); await read.started
 await f.queue.stop(); read.finish(reply(plan('Late shutdown')))
 await assert.rejects(read.promise, /SESSION_CONTEXT_CHANGED/)
 assert.equal((await f.repo.cacheKeys()).length, 0)
})
test('network fallback exposes the pending projection without private confirmation watermarks', async t => {
 const f = await fixture(t); await seed(f)
 await f.queue.submit({ operationId: 'offline-edit', input: { route: 'PUT /task/{id}', path: { id: '30' }, query: {}, body: { title: 'Kept locally' }, preconditions: { 'process:10': 'v1' } } })
 const result = await f.queue.api({ operation: 'GET /planning/tasks' }, async () => { throw new Error('Network down') })
 assert.equal(title(result), 'Kept locally'); assert.equal(result.localSnapshot, true)
 assert.equal(result.baseline['process:10'], 'local:offline-edit'); assert(!JSON.stringify(result).includes('_confirmed'))
})
test('an online-only write during projection work prevents an older GET from committing', async t => {
 const f = await fixture(t); await seed(f)
 const pause = f.pauseQueueRead(), pending = f.queue.api({ operation: 'GET /planning/tasks' }, async () => reply(plan('Stale during write')))
 await pause.entered
 const write = f.queue.api({ operation: 'POST /task/{id}/comments', path: { id: '30' } }, async () => ({ status: 201, data: { data: { id: 1 }, error: {} } }))
 await new Promise(resolve => setImmediate(resolve))
 pause.release(); await Promise.all([pending, write])
 assert.equal(title(await f.cached('/planning/tasks')), 'Before')
})
for (const status of [403, 404]) test('foreground permission ' + status + ' invalidates existing snapshots and pending cold reads', async t => {
 const f = await fixture(t); await seed(f)
 await f.queue.cachePut(base + '/permissions/me', { ts: 1, data: reply([]).data })
 const cold = held(f.queue, 'GET /task/{id}/comments', { path: { id: '7' } }); await cold.started
 const denied = await f.queue.api({ operation: 'GET /permissions/me' }, async () => ({ status, data: { data: null, error: { code: 'FORBIDDEN' } } }))
 assert.equal(denied.status, status); assert.equal((await f.cached('/planning/tasks')).status, 403)
 cold.finish(reply([{ id: 1, content: 'Before revocation' }]))
 await assert.rejects(cold.promise, /COMMAND_SNAPSHOT_CHANGED/)
 assert.equal(await f.cached('/task/7/comments'), undefined)
})
