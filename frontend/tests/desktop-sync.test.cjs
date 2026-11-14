'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { EventEmitter } = require('node:events')
const { createStorage } = require('../desktop/storage.cjs')
const { kinds } = require('../desktop/command-request.cjs')
const { bounded } = require('../desktop/protocol.cjs')
const { createCommandQueue } = require('../desktop/command-queue.cjs')
const { createSyncService, requestFor } = require('../desktop/sync-service.cjs')
const base = 'https://sync.example/api/v1'
const wrapped = (snapshot, tokens = {}) => ({ status: 200, data: { data: { snapshot, _revisions: tokens }, error: {} } })
const plan = title => ({ processes: [{ id: 10, project_id: 20, tasks: [{ id: 30, process_id: 10, title, resources: [] }], milestones: [] }] })
async function fixture(t, timers) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-sync-'))
  const storage = await createStorage({ directory }), listeners = new Set(), powerMonitor = new EventEmitter()
  const state = { contextId: 'one', server: base, user: { id: 7, preset: 'admin' }, mode: 'online', needsLogin: false }
  let time = 100000, alive = true, title = 'Server', token = 'v1', permissions = [{ resource: 'project', action: 'view', scope: 'all' }], respond = null, resources = []
  const calls = [], session = {
    status: () => structuredClone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async probe() { return alive }, async refresh() { if (alive) state.mode = 'online'; return state }, detach() {},
    async api(owner, request, internal) {
      assert.equal(internal.bypassQueue, true)
      calls.push(request)
      if (respond) { const value = await respond(request); if (value) return value }
      if (request.operation === 'GET /operations') return { status: 200, data: { data: { protocol: 1, durable: true, revision_protocol: 1, operations: [...kinds.keys()] } } }
      if (request.operation === 'PUT /task/{id}') return { status: 409, data: { error: { code: 'CONFLICT' } } }
      if (request.operation === 'GET /task/{id}') return wrapped({ id: 30, title }, { 'process:10': token })
      if (request.operation === 'GET /permissions/me') return wrapped(permissions)
      if (request.operation === 'GET /planning/tasks') return wrapped(plan(title), { 'process:10': token })
      if (request.operation === 'GET /resources') {
        const offset = Number(request.query?.offset || 0), limit = Number(request.query?.limit || 50)
        return wrapped({ items: resources.slice(offset, offset + limit), total: resources.length }, Object.fromEntries(resources.slice(offset, offset + limit).map(row => ['resource:' + row.id, 'r' + row.id])))
      }
      return { status: 403, data: { error: { code: 'FORBIDDEN' } } }
    },
  }
  const queue = createCommandQueue({ storage, session, rateMs: 0, acknowledgementMs: 0 })
  const sync = createSyncService({ storage, session, queue, powerMonitor, now: () => time, debounceMs: 3600000, rateMs: 0, timers })
  t.after(async () => { await sync.stop(); await queue.stop(); await storage.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const repo = storage.forScope({ server: base, accountId: 7 })
  return { storage, repo, session, queue, sync, powerMonitor, calls, state,
    advance(ms = 60001) { time += ms }, offline() { alive = false; state.mode = 'offline' }, online() { alive = true },
    server(value, version = 'v2') { title = value; token = version }, permissions(value) { permissions = value }, resources(value) { resources = value }, respond(fn) { respond = fn },
    switchAccount() { state.contextId = 'two'; state.user.id = 8; for (const fn of listeners) fn(state) },
    async snapshot() { return queue.control({ action: 'cacheGet', key: base + '/planning/tasks' }) },
    async seed() { await queue.cachePut(base + '/planning/tasks', { ts: 1, data: { data: plan('Before'), error: {} } }, { 'process:10': 'v1' }) },
  }
}
const task = snapshot => snapshot.data.data.processes[0].tasks[0]

test('one app owner refreshes baseline once and serves both windows without another GET', async t => {
  const f = await fixture(t); await f.sync.run(true)
  const count = f.calls.length
  const request = { operation: 'GET /planning/tasks', snapshotOnly: true }
  const send = () => { throw new Error('Renderer issued a background GET') }
  const windows = await Promise.all([f.queue.api(request, send), f.queue.api(request, send)])
  assert.equal(windows[0].data.data.processes[0].tasks[0].title, 'Server')
  assert.deepEqual(windows[0], windows[1]); assert.equal(f.calls.length, count)
  assert.equal(f.sync.status().lastPullAt, 100000)
})
test('automatic cycles obey the minute deadline, independent of renderer visibility', async t => {
  const f = await fixture(t); await f.sync.run(); const count = f.calls.filter(r => r.operation === 'GET /planning/tasks').length
  f.server('Later'); await f.sync.run(); assert.equal(f.calls.filter(r => r.operation === 'GET /planning/tasks').length, count)
  f.advance(); await f.sync.run(); assert.equal(task(await f.snapshot()).title, 'Later')
})
test('disabled automatic sync still detects recovery; explicit sync pulls', async t => {
  const f = await fixture(t); await f.queue.control({ action: 'configure', autoSync: false }); f.offline(); await f.sync.run()
  assert.equal(f.sync.status().reachable, false); assert.equal(f.sync.status().reconnectAt, 160000)
  f.online(); await f.sync.run(); assert.equal(f.sync.status().reachable, true); assert.equal(f.calls.length, 0)
  await f.sync.run(true); assert.equal(task(await f.snapshot()).title, 'Server')
})
test('full resource roster commits every page and filtered headers without truncation', async t => {
  const f = await fixture(t), rows = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, owner_id: i % 2 ? 8 : 7, name: 'Resource ' + i }))
  f.resources(rows)
  const pageKey = base + '/resources?limit=50&offset=0'
  await f.queue.cachePut(pageKey, { ts: 1, data: { data: { items: [], total: 0 } } })
  await f.sync.run(true)
  const all = await f.queue.control({ action: 'cacheGet', key: '/local/resource-header?owner_id=all' })
  const own = await f.queue.control({ action: 'cacheGet', key: '/local/resource-header?owner_id=7' })
  assert.equal(all.data.length, 1001); assert.equal(own.data.length, 501)
  const other = await f.queue.control({ action: 'cacheGet', key: '/local/resource-header?owner_id=8' })
  assert.equal(other.data.length, 500); assert.ok(other.data.every(row => row.owner_id === 8))
  assert.equal(Object.keys((await f.repo.cacheRead({ key: pageKey })).revisions).length, 50)
  assert.deepEqual(f.calls.filter(r => r.operation === 'GET /resources').map(r => r.query.offset), ['0', '500', '1000'])
})
test('inconsistent resource pagination never publishes a partial header', async t => {
  const f = await fixture(t); f.resources([{ id: 1, owner_id: 7 }]); await f.sync.run(true)
  f.respond(r => r.operation === 'GET /resources' ? wrapped({ items: Array.from({ length: 500 }, (_, i) => ({ id: i + 1 })), total: r.query.offset === '0' ? 501 : 502 }) : null)
  await f.sync.run(true)
  assert.equal(f.sync.status().code, 'SYNC_RESOURCE_SNAPSHOT_CHANGED')
  assert.equal((await f.queue.control({ action: 'cacheGet', key: '/local/resource-header?owner_id=all' })).data.length, 1)
})
test('owner changes and deletions replace all loaded resource pages and headers', async t => {
  const f = await fixture(t); f.resources([{ id: 1, owner_id: 7 }, { id: 2, owner_id: 7 }]); await f.sync.run(true)
  await f.queue.cachePut(base + '/resources?limit=50&offset=0', { ts: 1, data: { data: { items: [{ id: 1 }, { id: 2 }], total: 2 } } })
  f.resources([{ id: 2, owner_id: 8 }]); await f.sync.run(true)
  const page = await f.queue.cacheGet(base + '/resources?limit=50&offset=0')
  assert.deepEqual(page.data.data.items, [{ id: 2, owner_id: 8 }]); assert.equal(page.data.data.total, 1)
  assert.deepEqual((await f.queue.control({ action: 'cacheGet', key: '/local/resource-header?owner_id=7' })).data, [])
})
test('server baseline remains separate from a pending local edit during a pull', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'local-edit', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Local' }, preconditions: { 'process:10': 'v1' } } })
  f.online(); f.respond(r => r.operation === 'GET /operations' ? { status: 503 } : null); await f.sync.run(true)
  const raw = await f.repo.cacheRead({ key: base + '/planning/tasks' })
  assert.equal(raw.baseline.data.data.processes[0].tasks[0].title, 'Server'); assert.equal(task(await f.snapshot()).title, 'Local')
  assert.equal((await f.queue.control({ action: 'list' })).length, 1)
})
test('an old in-flight GET cannot overwrite a newer local commit', async t => {
  const f = await fixture(t); await f.seed(); let release, started
  const waiting = new Promise(resolve => { started = resolve })
  f.respond(r => r.operation === 'GET /planning/tasks' ? new Promise(resolve => { release = () => resolve(wrapped(plan('Stale'), { 'process:10': 'old' })); started() }) : null)
  const pull = f.sync.run(true); await waiting; f.offline()
  await f.queue.submit({ operationId: 'during-get', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'New local' }, preconditions: { 'process:10': 'v1' } } })
  release(); await pull
  assert.equal(task(await f.snapshot()).title, 'New local')
  const raw = await f.repo.cacheRead({ key: base + '/planning/tasks' }); assert.equal(raw.baseline.data.data.processes[0].tasks[0].title, 'Before')
})
for (const status of [403, 404]) test('HTTP ' + status + ' clears old data without discarding the queue or restoring it offline', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'retained', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Pending' }, preconditions: { 'process:10': 'v1' } } })
  f.online(); f.respond(r => r.operation === 'GET /operations' ? { status: 503 } : r.operation === 'GET /planning/tasks' ? { status, data: { error: { code: 'DENIED' } } } : null)
  await f.sync.run(true); assert.equal((await f.queue.cacheGet(base + '/planning/tasks')).status, status)
  const result = await f.queue.api({ operation: 'GET /planning/tasks' }, () => { throw new Error('Offline') })
  assert.equal(result.status, status); assert.equal(result.data.data, null); assert.equal((await f.queue.control({ action: 'list' })).length, 1)
})
test('changed permissions remove inaccessible snapshots even when later reads fail', async t => {
  const f = await fixture(t); await f.sync.run(true)
  f.permissions([]); f.respond(r => r.operation === 'GET /planning/tasks' ? { status: 503 } : null)
  await f.sync.run(true)
  assert.equal((await f.queue.cacheGet(base + '/planning/tasks')).status, 403)
})
test('a scoped pull cannot publish into another account', async t => {
  const f = await fixture(t); let release, started
  const waiting = new Promise(resolve => { started = resolve })
  f.respond(r => r.operation === 'GET /planning/tasks' ? new Promise(resolve => { release = () => resolve(wrapped(plan('Old account'))); started() }) : null)
  const pull = f.sync.run(true); await waiting; f.switchAccount(); release(); await pull
  assert.equal(await f.queue.cacheGet(base + '/planning/tasks'), undefined)
  assert.equal(f.sync.status().lastPullAt, null)
})
test('suspend cancels ownership and resume allows a fresh cycle', async t => {
  const f = await fixture(t); f.powerMonitor.emit('suspend'); await f.sync.run(true); assert.equal(f.calls.length, 0)
  f.powerMonitor.emit('resume'); await f.sync.run(true); assert.equal(task(await f.snapshot()).title, 'Server')
})
test('sync options reject arbitrary routes and values', async t => {
  const f = await fixture(t)
  await assert.rejects(f.sync.configure({ sql: true }), /SYNC_INVALID_REQUEST/)
  await assert.rejects(f.sync.configure({ resources: 'yes' }), /SYNC_INVALID_REQUEST/)
  await f.sync.configure({ resources: false }); await f.sync.run(true)
  assert.equal(f.calls.some(r => r.operation === 'GET /resources'), false)
})
for (const key of ['https://attacker.example/api/v1/task/1', base + '/operations/abc', base + '/task/-1', base + '/task/1?arbitrary=true', '/local/resource-header?owner_id=all']) test('cached key cannot authorize an arbitrary request: ' + key, () => {
  assert.equal(requestFor(base, key), null)
})

test('conflict review compares immutable intent with current server data without changing its wire', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'conflicting', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Local' }, preconditions: { 'process:10': 'v1' } } })
  f.online(); await f.sync.run(true)
  const before = (await f.queue.control({ action: 'list' }))[0]
  assert.equal(before.status, 'conflict')
  const review = await f.queue.control({ action: 'reviewConflict', operationId: before.operationId })
  assert.equal(review.local.title, 'Local'); assert.equal(review.server.title, 'Server'); assert.deepEqual(review.operationIds, ['conflicting'])
  assert.deepEqual((await f.queue.control({ action: 'list' }))[0], before)
  assert.equal(Object.hasOwn(review.local, '_preconditions'), false)
})
test('an unsent or unknown command cannot be presented as a confirmed conflict', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'pending', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Local' }, preconditions: { 'process:10': 'v1' } } })
  await assert.rejects(f.queue.control({ action: 'reviewConflict', operationId: 'pending' }), /COMMAND_NOT_CONFLICT/)
  await assert.rejects(f.queue.control({ action: 'reviewConflict', operationId: 'missing' }), /COMMAND_NOT_CONFLICT/)
})
test('permission invalidation is not undone by a later pending overlay', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'pending', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Local' }, preconditions: { 'process:10': 'v1' } } })
  await f.queue.invalidateReads([])
  await f.queue.submit({ operationId: 'pending-two', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'More' }, preconditions: { 'process:10': 'local:pending' } } })
  assert.equal((await f.queue.cacheGet(base + '/planning/tasks')).status, 403)
  assert.equal((await f.queue.control({ action: 'list' })).length, 2)
})
test('large read revision maps fit response budgets without widening renderer request limits', () => {
  const revisions = Object.fromEntries(Array.from({ length: 501 }, (_, i) => ['resource:' + (i + 1), 'uuid']))
  assert.equal(bounded({ revisions }, 8 * 1024 * 1024), true)
  assert.equal(bounded({ revisions }), false)
})

test('cache-only manual warmup does not send or thaw the durable queue', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'held-for-push', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Local' }, preconditions: { 'process:10': 'v1' } } })
  f.online(); await f.sync.run(true, true)
  assert.equal(f.calls.some(row => row.operation === 'PUT /task/{id}'), false)
  assert.equal((await f.queue.control({ action: 'list' }))[0].status, 'queued')
  assert.equal(task(await f.snapshot()).title, 'Local')
})

test('snapshot hydration never issues a cold network request', async t => {
  const f = await fixture(t); let sends = 0
  const result = await f.queue.api({ operation: 'GET /task/{id}', path: { id: '99' }, snapshotOnly: true }, () => { sends++; return wrapped({ id: 99 }) })
  assert.equal(result.status, 503); assert.equal(sends, 0)
})
test('an explicit foreground read refreshes an existing snapshot and publishes it', async t => {
  const f = await fixture(t); await f.seed(); const before = f.queue.status().snapshotRevision
  const result = await f.queue.api({ operation: 'GET /planning/tasks' }, () => Promise.resolve(wrapped(plan('Explicit refresh'), { 'process:10': 'new' })))
  assert.equal(result.data.data.processes[0].tasks[0].title, 'Explicit refresh')
  assert.ok(f.queue.status().snapshotRevision > before)
})

test('foreground permission refresh closes old scoped snapshots before publishing revoked rights', async t => {
  const f = await fixture(t); await f.seed()
  await f.queue.cachePut(base + '/permissions/me', { ts: 1, data: { data: [{ resource: 'project', action: 'view', scope: 'all' }] } })
  await f.queue.api({ operation: 'GET /permissions/me' }, () => Promise.resolve(wrapped([])))
  assert.equal((await f.queue.cacheGet(base + '/planning/tasks')).status, 403)
  assert.deepEqual((await f.queue.cacheGet(base + '/permissions/me')).data.data, [])
})
test('missing window queries are registered once with main and refreshed on manual pull', async t => {
  const f = await fixture(t), request = { operation: 'GET /user/{id}/days', path: { id: '7' }, query: { start_date: '2026-11-01', end_date: '2026-11-30' }, snapshotOnly: true }
  await Promise.all([f.queue.api(request, () => { throw new Error('Window GET') }), f.queue.api(request, () => { throw new Error('Window GET') })])
  assert.equal(f.calls.length, 0); await f.sync.run(true, true)
  assert.equal(f.calls.filter(row => row.operation === request.operation).length, 1)
})

function scheduler() {
  const intervals = new Set(), timeouts = new Set()
  const create = (collection, callback, ms) => { const timer = { callback, ms, unref() {} }; collection.add(timer); return timer }
  return { intervals, timeouts,
    setInterval: (fn, ms) => create(intervals, fn, ms), clearInterval: timer => intervals.delete(timer),
    setTimeout: (fn, ms) => create(timeouts, fn, ms), clearTimeout: timer => timeouts.delete(timer),
  }
}
test('the timer path owns one minute pull regardless of window subscriptions', async t => {
  const timers = scheduler(), f = await fixture(t, timers)
  f.sync.subscribe(() => {}); f.sync.subscribe(() => {})
  assert.equal(timers.intervals.size, 1); assert.equal([...timers.intervals][0].ms, 10000)
  const startup = [...timers.timeouts][0]; startup.callback(); await f.sync.run()
  const count = f.calls.filter(row => row.operation === 'GET /planning/tasks').length
  f.server('Timer update'); f.advance(30000); [...timers.intervals][0].callback(); await f.sync.run()
  assert.equal(f.calls.filter(row => row.operation === 'GET /planning/tasks').length, count)
  f.advance(30000); [...timers.intervals][0].callback(); await f.sync.run()
  assert.equal(f.calls.filter(row => row.operation === 'GET /planning/tasks').length, count + 1)
  assert.equal(task(await f.snapshot()).title, 'Timer update')
  await f.sync.stop(); assert.equal(timers.intervals.size, 0)
})
test('a GET started before suspend cannot publish after resume', async t => {
  const f = await fixture(t); await f.seed(); let release, started
  const waiting = new Promise(resolve => { started = resolve })
  f.respond(r => r.operation === 'GET /planning/tasks' ? new Promise(resolve => { release = () => resolve(wrapped(plan('Before sleep'))); started() }) : null)
  const pull = f.sync.run(true); await waiting
  f.powerMonitor.emit('suspend'); f.powerMonitor.emit('resume'); release(); await pull
  assert.equal(task(await f.snapshot()).title, 'Before')
  f.respond(null); f.server('After wake'); await f.sync.run(true)
  assert.equal(task(await f.snapshot()).title, 'After wake')
})
test('a slow foreground GET cannot restore permissions superseded by a newer pull', async t => {
  const f = await fixture(t); await f.sync.run(true); let release
  const response = new Promise(resolve => { release = resolve })
  const old = f.queue.api({ operation: 'GET /permissions/me' }, () => response)
  await new Promise(resolve => setImmediate(resolve))
  f.permissions([]); await f.sync.run(true)
  release(wrapped([{ resource: 'project', action: 'view', scope: 'all' }]))
  const result = await old
  assert.deepEqual(result.data.data, [])
  assert.deepEqual((await f.queue.cacheGet(base + '/permissions/me')).data.data, [])
})

test('timesheet conflict review uses the affected date window', async t => {
  const f = await fixture(t); f.offline()
  await f.queue.submit({ operationId: 'period-conflict', input: { route: 'PUT /user/{id}/days', path: { id: '7' }, body: { state_id: 2, start_date: '2026-11-02', end_date: '2026-11-05' }, preconditions: { 'user_days:7': 'u1', states: 's1' } } })
  f.respond(request => request.operation === 'PUT /user/{id}/days' ? { status: 409, data: { error: { code: 'CONFLICT' } } } : request.operation === 'GET /user/{id}/days' ? wrapped([]) : null)
  f.online(); await f.sync.run(true)
  const review = await f.queue.control({ action: 'reviewConflict', operationId: 'period-conflict' })
  assert.deepEqual(review.server, [])
  assert.deepEqual(f.calls.findLast(row => row.operation === 'GET /user/{id}/days').query, { start_date: '2026-11-02', end_date: '2026-11-05' })
})
test('a late successful receipt cannot resurrect a revoked snapshot', async t => {
  const f = await fixture(t); await f.seed(); f.offline()
  await f.queue.submit({ operationId: 'late-accepted', input: { route: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Accepted' }, preconditions: { 'process:10': 'v1' } } })
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  f.respond(request => request.operation === 'PUT /task/{id}' ? new Promise(resolve => { release = () => resolve(wrapped({ id: 30, process_id: 10, title: 'Accepted' }, { 'process:10': 'v2' })); started() }) : null)
  f.online(); const push = f.queue.push(true); await waiting
  await f.queue.invalidateReads([]); release(); await push
  assert.equal((await f.repo.receipt({ operationId: 'late-accepted' })).status, 'confirmed')
  assert.equal((await f.queue.cacheGet(base + '/planning/tasks')).status, 403)
  assert.equal((await f.queue.cacheGet(base + '/planning/tasks')).data.data, null)
})
