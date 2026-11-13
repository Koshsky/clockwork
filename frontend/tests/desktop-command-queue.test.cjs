'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createStorage } = require('../desktop/storage.cjs')
const { createCommandQueue } = require('../desktop/command-queue.cjs')
const { requestHash, requestPath, kinds, validMutation } = require('../desktop/command-request.cjs')
const base = 'https://queue.example/api/v1'
const planning = { ts: 1, data: { data: { processes: [{ id: 10, project_id: 20, tasks: [{ id: 30, process_id: 10, title: 'Before', resources: [] }], milestones: [] }] }, error: {} } }
const mutation = (title = 'After') => ({ route: 'PUT /task/{id}', path: { id: '30' }, query: {}, body: { title } })
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-command-queue-'))
  let storage = await createStorage({ directory })
  const state = { server: base, user: { id: 7 }, mode: 'offline', needsLogin: false, contextId: 'context-1' }
  let tick = 1000, counter = 100, token = 'process-v1', lose = false, responseStatus = null, supported = true
  const calls = [], receipts = new Map(), listeners = new Set(), serverRows = new Map([[30, { id: 30, process_id: 10, title: 'Before' }]])
  const session = { status: () => structuredClone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async refresh() { return state }, async api(owner, request) {
    if (state.mode !== 'online') throw new Error('SESSION_OFFLINE')
    if (request.operation === 'GET /operations') return { status: 200, data: { data: { protocol: 1, durable: supported, revision_protocol: 1, operations: [...kinds.keys()] } } }
    if (request.operation === 'GET /operations/{operation_id}') return { status: 200, data: { data: receipts.get(request.path.operation_id) || { state: 'not_found' } } }
    calls.push(structuredClone(request))
    if (responseStatus) return { status: responseStatus, data: { error: { message: 'Rejected', code: responseStatus } }, operationStatus: 'unrecorded' }
    if (request.body?._preconditions?.['process:10'] && request.body._preconditions['process:10'] !== token) return { status: 409, data: { error: { message: 'Conflict', code: 'CONFLICT' } }, operationStatus: 'unrecorded' }
    const id = Number(request.path?.id) || ++counter, previous = serverRows.get(id)
    const body = Object.fromEntries(Object.entries(request.body || {}).filter(([key]) => key !== '_preconditions')), row = { ...previous, ...body, id, process_id: body.process_id || previous?.process_id || 10 }
    if (request.operation.startsWith('DELETE')) serverRows.delete(id); else serverRows.set(id, row)
    token = 'process-v' + (++counter)
    const data = { data: { snapshot: request.operation.startsWith('DELETE') ? {} : row, _revisions: { 'process:10': token, ['project:' + id]: 'project-created' } }, error: {} }
    const response = { status: request.operation.startsWith('POST') ? 201 : 200, data }
    receipts.set(request.operationId, { state: 'confirmed', method: request.operation.split(' ')[0], path: requestPath({ route: request.operation, path: request.path, query: request.query, body: request.body }), request_hash: requestHash(request.body), response_status: response.status, response: data })
    if (lose) { lose = false; throw new Error('Connection reset after commit') }
    return response
  } }
  const make = () => createCommandQueue({ storage, session, now: () => tick, rateMs: 0, acknowledgementMs: 0 })
  let queue = make()
  t.after(async () => { await queue.stop(); await storage.close(); await fs.rm(directory, { recursive: true, force: true }) })
  await queue.cachePut(base + '/planning/tasks', planning, { 'process:10': token, 'project:20': 'project-v1', states: 'states-v1', 'user_days:7': 'days-v1', 'resource:40': 'resource-v1' })
  return { get storage() { return storage }, directory, session, calls, receipts, serverRows, get queue() { return queue }, online() { state.mode = 'online' },
    switchAccount() { state.user = { id: 8 }; state.contextId = 'context-2'; for (const fn of listeners) fn(state) },
    logout() { state.user = null; state.mode = 'signedOut'; state.contextId = 'logged-out'; for (const fn of listeners) fn(state) },
    loseResponse() { lose = true }, status(value) { responseStatus = value }, unsupported() { supported = false }, advance(ms = 60001) { tick += ms },
    async restart() { await queue.stop(); await storage.close(); storage = await createStorage({ directory }); queue = make() },
    async submit(input = mutation(), operationId = randomUUID()) { const result = await queue.submit({ input, operationId }); await queue.push(); return { result, operationId } },
  }
}
const task = async f => (await f.queue.cacheGet(base + '/planning/tasks')).data.data.processes[0].tasks[0]

test('offline acknowledgement follows durable command and projection commit', async t => {
  const f = await fixture(t), { result, operationId } = await f.submit()
  assert.equal(result.queued, true); assert.equal((await task(f)).title, 'After'); assert.equal(f.calls.length, 0)
  assert.equal((await f.storage.forScope({ server: base, accountId: 7 }).receipt({ operationId })).status, 'queued')
})
for (const confirmed of [false, true]) test('operation identity rejects changed intent, confirmed=' + confirmed, async t => {
  const f = await fixture(t), { operationId } = await f.submit()
  if (confirmed) { f.online(); await f.queue.push() }
  await assert.rejects(f.submit(mutation('Other'), operationId), { code: 'STORAGE_OPERATION_REUSED' })
  assert.equal(f.calls.length, confirmed ? 1 : 0)
})
test('multiple windows share one sender and one acknowledgement', async t => {
  const f = await fixture(t), { operationId } = await f.submit(); f.online(); await Promise.all([f.queue.push(), f.queue.push(), f.queue.push()])
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operationId, operationId); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('dependent edits advance only from their predecessor receipt', async t => {
  const f = await fixture(t); await f.submit(mutation('First')); await f.submit(mutation('Second')); f.online(); await f.queue.push()
  assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0].body._preconditions['process:10'], f.calls[1].body._preconditions['process:10'])
  assert.equal(f.serverRows.get(30).title, 'Second'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
for (const restart of [false, true]) test('lost response recovers by receipt without reexecution, restart=' + restart, async t => {
  const f = await fixture(t), { operationId } = await f.submit(); f.loseResponse(); f.online(); await f.queue.push()
  assert.equal((await f.queue.control({ action: 'list' }))[0].status, 'unknown'); assert.equal(f.serverRows.get(30).title, 'After')
  if (restart) await f.restart()
  f.advance(); await f.queue.push(); assert.equal(f.calls.length, 1); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
  assert.equal((await f.storage.forScope({ server: base, accountId: 7 }).receipt({ operationId })).status, 'confirmed')
})
for (const status of [400, 403, 404, 409, 422]) test('HTTP ' + status + ' parks the command and restores baseline', async t => {
  const f = await fixture(t); await f.submit(); f.status(status); f.online(); await f.queue.push()
  assert.equal((await f.queue.control({ action: 'list' }))[0].status, status === 409 ? 'conflict' : 'rejected')
  assert.equal((await task(f)).title, 'Before'); f.advance(); await f.queue.push(); assert.equal(f.calls.length, 1)
})
for (const status of [401, 429, 500, 503]) test('HTTP ' + status + ' preserves unknown outcome and exact wire', async t => {
  const f = await fixture(t); await f.submit(); f.status(status); f.online(); await f.queue.push()
  const rows = await f.queue.control({ action: 'list' }); assert.equal(rows[0].status, 'unknown'); assert.equal(rows[0].http.wire.body.title, 'After'); assert.equal((await task(f)).title, 'After')
})
test('unknown outcome cannot be silently discarded', async t => {
  const f = await fixture(t), { operationId } = await f.submit(); f.loseResponse(); f.online(); await f.queue.push()
  await assert.rejects(f.queue.control({ action: 'discard', operationIds: [operationId] }), { code: 'STORAGE_OUTCOME_UNKNOWN' })
})
test('explicit discard restores baseline and retains durable audit receipt', async t => {
  const f = await fixture(t), { operationId } = await f.submit(); await f.queue.control({ action: 'discard', operationIds: [operationId] })
  assert.equal((await task(f)).title, 'Before'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
  assert.equal((await f.storage.forScope({ server: base, accountId: 7 }).receipt({ operationId })).status, 'queued')
})
test('background GET cannot erase pending projection', async t => {
  const f = await fixture(t); await f.submit(); await f.queue.cachePut(base + '/planning/tasks', planning, { 'process:10': 'external-version' }); assert.equal((await task(f)).title, 'After')
})
test('missing baseline prevents blind acknowledgement', async t => {
  const f = await fixture(t); await assert.rejects(f.submit({ route: 'PUT /task/{id}', path: { id: '999' }, body: { title: 'Unknown' } }), /COMMAND_BASELINE_REQUIRED/)
  assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('unsupported server never receives unprotected fallback', async t => {
  const f = await fixture(t); await f.submit(); f.unsupported(); f.online(); await f.queue.push(); assert.equal(f.calls.length, 0); assert.equal((await f.queue.control({ action: 'list' })).length, 1)
})
test('account switch keeps previous queue isolated and unsent', async t => {
  const f = await fixture(t); await f.submit(); f.switchAccount(); f.online(); await f.queue.push(); assert.equal(f.calls.length, 0); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
  assert.equal((await f.storage.forScope({ server: base, accountId: 7 }).queue()).length, 1)
})
test('logout keeps durable commands and stops future sends', async t => {
  const f = await fixture(t); await f.submit(); f.logout(); await f.queue.push(); assert.equal(f.calls.length, 0); assert.equal((await f.storage.forScope({ server: base, accountId: 7 }).queue()).length, 1)
})
test('administrator impersonation cannot enqueue writes', async t => {
  const f = await fixture(t); await assert.rejects(f.queue.api({ operation: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Wrong' }, viewUser: 8 }, () => {}), /COMMAND_VIEW_ONLY/)
})
test('wire hash matches backend golden vector', () => {
  assert.equal(requestHash({ name: 'same' }), '5d220211854323ba0e8a89430062da590371afa8f877f20e96f46fb26f33077f')
})
for (const route of ['POST /user', 'POST /auth/login', 'POST /comment', 'POST /rbac/presets', 'POST https://evil.example/task']) test('online-only route is never durable: ' + route, () => { assert.equal(validMutation({ route, body: { title: 'No' } }), false) })

test('create edit delete resolves temporary IDs and preserves FIFO across a restart', async t => {
  const f = await fixture(t)
  await f.submit({ route: 'POST /task', path: {}, query: {}, body: { title: 'Created', process_id: 10 }, tempId: -11001 })
  await f.submit({ route: 'PUT /task/{id}', path: { id: '-11001' }, query: {}, body: { title: 'Edited' } })
  await f.submit({ route: 'DELETE /task/{id}', path: { id: '-11001' }, query: {} })
  await f.restart(); f.online(); await f.queue.push()
  assert.equal(f.calls.length, 3, JSON.stringify(await f.queue.control({ action: 'list' }))); const real = Number(f.calls[1].path.id)
  assert.ok(real > 0); assert.equal(f.calls[2].path.id, String(real)); assert.equal(f.serverRows.has(real), false)
  assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('conflicting cached versions cannot lend a newer token to stale data', async t => {
  const f = await fixture(t)
  await f.queue.cachePut(base + '/process/10', { ts: 2, data: { data: { id: 10, project_id: 20 } } }, { 'process:10': 'newer-version' })
  await assert.rejects(f.submit(), /COMMAND_BASELINE_AMBIGUOUS/); assert.equal(f.calls.length, 0)
})
test('rejecting a predecessor does not send its dependent command', async t => {
  const f = await fixture(t); await f.submit(mutation('First')); await f.submit(mutation('Second')); f.status(403); f.online(); await f.queue.push()
  assert.equal(f.calls.length, 1); const rows = await f.queue.control({ action: 'list' }); assert.equal(rows[0].status, 'rejected'); assert.equal(rows[1].ready, false)
})
test('a fresh GET after rejection does not resurrect the rejected optimistic edit', async t => {
  const f = await fixture(t); await f.submit(); f.status(403); f.online(); await f.queue.push()
  await f.queue.cachePut(base + '/planning/tasks', planning, { 'process:10': 'process-v1' }); assert.equal((await task(f)).title, 'Before')
})
for (const field of ['request_hash', 'path', 'method']) test('receipt ' + field + ' mismatch never acknowledges another request', async t => {
  const f = await fixture(t), { operationId } = await f.submit(); f.loseResponse(); f.online(); await f.queue.push()
  f.receipts.get(operationId)[field] = 'wrong'; f.advance(); await f.queue.push()
  assert.equal((await f.queue.control({ action: 'list' }))[0].status, 'unknown'); assert.equal(f.calls.length, 1)
})
test('discarding a parent with pending dependents is rejected atomically', async t => {
  const f = await fixture(t), first = await f.submit(); await f.submit(mutation('Second'))
  await assert.rejects(f.queue.control({ action: 'discard', operationIds: [first.operationId] }), { code: 'STORAGE_DEPENDENTS_EXIST' })
  assert.equal((await f.queue.control({ action: 'list' })).length, 2)
})

test('sequential online edits of the same entity advance from durable own acknowledgements', async t => {
  const f = await fixture(t); await f.submit(mutation('First')); f.online(); await f.queue.push()
  await f.submit(mutation('Second')); await f.queue.push()
  assert.equal(f.calls.length, 2); assert.equal(f.serverRows.get(30).title, 'Second'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('a reused temporary creator ID is refused before a second POST', async t => {
  const f = await fixture(t), input = { route: 'POST /task', body: { title: 'First', process_id: 10 }, tempId: -11009 }
  await f.submit(input)
  await assert.rejects(f.submit({ ...input, body: { title: 'Collision', process_id: 10 } }), { code: 'STORAGE_CONFLICT' })
  f.online(); await f.queue.push(); assert.equal(f.calls.length, 1)
})

test('local projection failure rolls back its command, metadata and queued receipt together', async t => {
  const f = await fixture(t), repository = f.storage.forScope({ server: base, accountId: 7 })
  const initial = await repository.cacheRead({ key: base + '/planning/tasks' })
  await assert.rejects(repository.commitHttp({ operationId: 'atomic-rejected', input: mutation(), changes: [{ key: initial.key, expectedRevision: initial.revision + 1, baseline: initial.baseline, projection: { bad: true } }] }), { code: 'STORAGE_STALE_REVISION' })
  assert.equal(await repository.receipt({ operationId: 'atomic-rejected' }), null); assert.equal((await repository.queue()).length, 0)
  assert.deepEqual((await repository.cacheRead({ key: initial.key })).projection, initial.projection)
})
test('settlement projection failure preserves unknown state and never commits its ID mapping', async t => {
  const f = await fixture(t), repository = f.storage.forScope({ server: base, accountId: 7 })
  const { operationId } = await f.submit({ route: 'POST /task', body: { title: 'New', process_id: 10 }, tempId: -22001 })
  await repository.markAttempt({ operationId })
  const initial = await repository.cacheRead({ key: base + '/planning/tasks' })
  await assert.rejects(repository.settle({ operationId, status: 'confirmed', result: { status: 201, data: { data: { id: 99 } } }, mappings: [{ entity: 'http', temporaryId: -22001, realId: 99 }], cacheChanges: [{ key: initial.key, expectedRevision: initial.revision + 1, baseline: {}, projection: {} }] }), { code: 'STORAGE_STALE_REVISION' })
  assert.equal((await repository.receipt({ operationId })).status, 'unknown'); assert.equal(await repository.resolveId({ entity: 'http', temporaryId: -22001 }), null)
})
test('the frozen wire cannot change between delivery attempts', async t => {
  const f = await fixture(t), { operationId } = await f.submit(), repository = f.storage.forScope({ server: base, accountId: 7 })
  await repository.freezeHttp({ operationId, wire: { route: mutation().route, body: { title: 'Frozen' } } })
  await assert.rejects(repository.freezeHttp({ operationId, wire: { route: mutation().route, body: { title: 'Changed' } } }), { code: 'STORAGE_OPERATION_REUSED' })
})
test('logout during an in-flight delivery leaves it unknown and never sends subsequent commands', async t => {
  const f = await fixture(t), first = await f.submit(mutation('First')); await f.submit(mutation('Second'))
  let held, release; const arrived = new Promise(resolve => { held = resolve }), gate = new Promise(resolve => { release = resolve }), original = f.session.api
  f.session.api = async (...args) => { if (!args[1].operation.startsWith('GET ')) { held(); await gate } return original(...args) }
  f.online(); const sending = f.queue.push(); await arrived; f.logout(); release(); await sending
  assert.equal(f.calls.length, 0); assert.equal((await f.storage.forScope({ server: base, accountId: 7 }).receipt({ operationId: first.operationId })).status, 'unknown')
})

test('timesheet projection updates batch days and only the affected calendar dates atomically', async t => {
  const f = await fixture(t), put = (path, data, revisions = {}) => f.queue.cachePut(base + path, { ts: 1, data: { data, error: {} } }, revisions)
  await put('/timesheet/states', [{ id: 9, code: 'OFF', name: 'Away', is_available: false }], { states: 'states-v1' })
  await put('/resources/40/members', [{ id: 7, name: 'Employee' }], { 'resource:40': 'resource-v1' })
  const days = '/user/days?user_ids=7&start_date=2026-11-09&end_date=2026-11-15'
  await put(days, [{ user_id: 7, days: [] }], { 'user_days:7': 'days-v1', states: 'states-v1' })
  const calendar = '/timesheet/calendar?start_date=2026-11-09&end_date=2026-11-15'
  await put(calendar, { resources: [{ resource_id: 40, periods: [{ start_date: '2026-11-09', end_date: '2026-11-15', available: 2, unavailable: 0 }] }] })
  await f.submit({ route: 'PUT /user/{id}/days', path: { id: '7' }, body: { state_id: 9, start_date: '2026-11-10', end_date: '2026-11-11' } })
  const periods = (await f.queue.cacheGet(base + calendar)).data.data.resources[0].periods
  assert.equal(periods.find(row => row.start_date === '2026-11-10').available, 1)
  assert.equal(periods.find(row => row.start_date === '2026-11-09').available, 2)
  assert.equal(periods.find(row => row.start_date === '2026-11-12').available, 2)
  assert.equal((await f.queue.cacheGet(base + days)).data.data[0].days[0].is_available, false)
  await f.submit({ route: 'DELETE /user/{id}/days', path: { id: '7' }, query: { start_date: '2026-11-11', end_date: '2026-11-11' } })
  const after = (await f.queue.cacheGet(base + calendar)).data.data.resources[0].periods
  assert.equal(after.find(row => row.start_date === '2026-11-10').available, 1)
  assert.equal(after.find(row => row.start_date === '2026-11-11').available, 2)
})
test('discarding an absence restores both timesheet and capacity without losing other dates', async t => {
  const f = await fixture(t), put = (path, data) => f.queue.cachePut(base + path, { ts: 1, data: { data } })
  await put('/timesheet/states', [{ id: 9, is_available: false }]); await put('/resources/40/members', [{ id: 7 }])
  await put('/user/days', [{ user_id: 7, days: [] }]); await put('/timesheet/calendar', { resources: [{ resource_id: 40, periods: [{ start_date: '2026-11-09', end_date: '2026-11-15', available: 2, unavailable: 0 }] }] })
  const { operationId } = await f.submit({ route: 'PUT /user/{id}/days', path: { id: '7' }, body: { state_id: 9, start_date: '2026-11-10', end_date: '2026-11-11' } })
  await f.queue.control({ action: 'discard', operationIds: [operationId] })
  assert.deepEqual((await f.queue.cacheGet(base + '/user/days')).data.data[0].days, [])
  assert.equal((await f.queue.cacheGet(base + '/timesheet/calendar')).data.data.resources[0].periods[0].available, 2)
})
test('a negative numeric quantity is never rewritten as an entity ID', async t => {
  const f = await fixture(t)
  await f.submit({ route: 'POST /assignment', body: { task_id: 30, resource_id: 40, quantity: -30 }, tempId: -30001 })
  f.online(); await f.queue.push(); assert.equal(f.calls[0].body.quantity, -30); assert.equal(f.calls[0].body.task_id, 30)
})

test('reverse lexical operation IDs never change causal revision order', async t => {
  const f = await fixture(t)
  await f.submit(mutation('First'), 'z-command'); await f.submit(mutation('Second'), 'm-command'); await f.submit(mutation('Last'), 'a-command')
  f.online(); await f.queue.push(); assert.equal(f.calls.length, 3); assert.equal(f.serverRows.get(30).title, 'Last'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('a 503 retry checks missing receipt then resends identical frozen bytes', async t => {
  const f = await fixture(t); await f.submit(); f.status(503); f.online(); await f.queue.push(); f.status(null); f.advance(); await f.queue.push()
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].body, f.calls[0].body); assert.equal(f.calls[1].operationId, f.calls[0].operationId)
  assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('manual Push still respects a server rate-limit delay', async t => {
  const f = await fixture(t); await f.submit(); f.status(429); f.online(); await f.queue.push(); f.status(null)
  await f.queue.control({ action: 'push' }); assert.equal(f.calls.length, 1); f.advance(); await f.queue.control({ action: 'push' }); assert.equal(f.calls.length, 2)
})
test('a rejected command does not block an independent resource creation', async t => {
  const f = await fixture(t), original = f.session.api
  f.session.api = async (owner, request) => request.operation === 'PUT /task/{id}' ? { status: 403, data: { error: { message: 'Denied' } } } : original(owner, request)
  await f.submit(); await f.submit({ route: 'POST /resources', body: { code: 'Independent', owner_id: 7 }, tempId: -40101 }); f.online(); await f.queue.push()
  const rows = await f.queue.control({ action: 'list' }); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'rejected'); assert.equal(f.calls[0].operation, 'POST /resources')
})

test('queue pages retain their cursor even when a whole page was explicitly discarded', async t => {
  const f = await fixture(t), ids = []
  for (let i = 0; i < 5; i++) ids.push((await f.submit({ route: 'POST /resources', body: { code: 'Resource-' + i, owner_id: 7 }, tempId: -50001 - i })).operationId)
  await f.queue.control({ action: 'discard', operationIds: ids.slice(0, 4) })
  const first = await f.queue.control({ action: 'list', after: 0 })
  assert.equal(first.items.length, 0); assert.equal(first.complete, false)
  const last = await f.queue.control({ action: 'list', after: first.after })
  assert.equal(last.items[0].operationId, ids[4]); assert.equal(last.complete, true)
})

test('disabled auto-sync persists across restart and requires explicit Push for an old queue', async t => {
  const f = await fixture(t); await f.queue.control({ action: 'configure', autoSync: false }); await f.submit(); await f.restart(); f.online(); f.advance(); await f.queue.push()
  assert.equal(f.calls.length, 0); assert.equal((await f.queue.control({ action: 'list' })).length, 1)
  await f.queue.control({ action: 'push' }); assert.equal(f.calls.length, 1); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('disabled auto-sync still permits an explicit new online save', async t => {
  const f = await fixture(t); await f.queue.control({ action: 'configure', autoSync: false }); f.online(); await f.submit()
  assert.equal(f.calls.length, 1); assert.equal(f.serverRows.get(30).title, 'After')
})

test('a confirmed optimistic edit remains in the durable baseline without another GET', async t => {
  const f = await fixture(t); await f.submit(); f.online(); await f.queue.push(); await f.restart()
  assert.equal((await task(f)).title, 'After')
  const cached = await f.queue.control({ action: 'cacheGet', key: base + '/planning/tasks' })
  assert.equal(cached.data.data.processes[0].tasks[0]._baseline['process:10'], f.calls.length ? 'process-v101' : '')
})
test('an old window cannot borrow a completed acknowledgement for its stale baseline', async t => {
  const f = await fixture(t), old = { 'process:10': 'process-v1' }; f.online()
  await f.submit({ ...mutation('First'), preconditions: old })
  await f.submit({ ...mutation('Stale window'), preconditions: old })
  assert.equal(f.calls.length, 2); assert.equal(f.serverRows.get(30).title, 'First')
  assert.equal((await f.queue.control({ action: 'list' }))[0].status, 'conflict')
})
test('actual edited row metadata is not blocked by unrelated historical cache URLs', async t => {
  const f = await fixture(t)
  await f.queue.cachePut(base + '/process/10', { ts: 2, data: { data: { id: 10, project_id: 20 } } }, { 'process:10': 'historical-token' })
  f.online(); await f.submit({ ...mutation('Current view'), preconditions: { 'process:10': 'process-v1' } })
  assert.equal(f.serverRows.get(30).title, 'Current view'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
  const visible = await f.queue.control({ action: 'cacheGet', key: base + '/planning/tasks' })
  await f.submit({ ...mutation('Next current edit'), preconditions: visible.data.data.processes[0].tasks[0]._baseline })
  assert.equal(f.serverRows.get(30).title, 'Next current edit')
  assert.equal((await task(f)).title, 'Next current edit')
  assert.equal(Object.hasOwn(await f.queue.control({ action: 'cacheGet', key: base + '/planning/tasks' }), '_confirmed'), false)
})
for (const action of ['read', 'write']) test('account switch while cache ' + action + ' awaits SQLite never returns the old payload', async t => {
  const f = await fixture(t), forScope = f.storage.forScope.bind(f.storage)
  let arrived, release, intercepted = false
  const held = new Promise(resolve => { arrived = resolve }), gate = new Promise(resolve => { release = resolve })
  f.storage.forScope = scope => {
    const repository = forScope(scope)
    return { ...repository, async cacheRead(input) {
      const value = await repository.cacheRead(input)
      if (!intercepted) { intercepted = true; arrived(); await gate }
      return value
    } }
  }
  const work = action === 'read' ? f.queue.control({ action: 'cacheGet', key: base + '/planning/tasks' }) : f.queue.cachePut(base + '/planning/tasks', planning)
  const rejected = assert.rejects(work, /SESSION_CONTEXT_CHANGED/)
  await held; f.switchAccount(); release(); await rejected
  assert.deepEqual(await forScope({ server: base, accountId: 8 }).cacheKeys(), [])
})
test('turning off auto-sync during one request prevents automatic delivery of the remaining queue', async t => {
  const f = await fixture(t); await f.submit(mutation('First')); await f.submit(mutation('Second'))
  let arrived, release; const held = new Promise(resolve => { arrived = resolve }), gate = new Promise(resolve => { release = resolve }), original = f.session.api
  f.session.api = async (...args) => { if (!args[1].operation.startsWith('GET ')) { arrived(); await gate } return original(...args) }
  f.online(); const sending = f.queue.push(); await held; await f.queue.control({ action: 'configure', autoSync: false }); release(); await sending
  assert.equal(f.calls.length, 1); assert.equal((await f.queue.control({ action: 'list' })).length, 1)
})
test('manual Push is retained while an explicit save is already in flight with auto-sync disabled', async t => {
  const f = await fixture(t); await f.queue.control({ action: 'configure', autoSync: false }); await f.submit({ route: 'POST /resources', tempId: -60002, body: { code: 'Old queue', owner_id: 7 } })
  let arrived, release; const held = new Promise(resolve => { arrived = resolve }), gate = new Promise(resolve => { release = resolve }), original = f.session.api
  f.session.api = async (...args) => { if (args[1].operation === 'POST /resources') { arrived(); await gate } return original(...args) }
  f.online(); const saving = f.queue.submit({ operationId: randomUUID(), input: { route: 'POST /resources', tempId: -60001, body: { code: 'Explicit save', owner_id: 7 } } })
  await held; const manual = f.queue.control({ action: 'push' }); release(); await Promise.all([saving, manual])
  assert.equal(f.calls.length, 2); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})

test('a read begun before a mutation never exposes its stale body when no earlier cache exists', async t => {
  const f = await fixture(t)
  let arrived, release; const held = new Promise(resolve => { arrived = resolve }), gate = new Promise(resolve => { release = resolve })
  const reading = f.queue.api({ operation: 'GET /task/{id}', path: { id: '30' } }, async () => { arrived(); await gate; return { status: 200, data: { data: { snapshot: { id: 30, process_id: 10, title: 'Before' }, _revisions: { 'process:10': 'process-v1' } } } } })
  const rejected = assert.rejects(reading, /COMMAND_SNAPSHOT_CHANGED/)
  await held; await f.submit(); release(); await rejected
  assert.equal((await task(f)).title, 'After')
})

test('the native resource header cache preserves its raw array instead of adding an HTTP envelope', async t => {
  const f = await fixture(t), key = '/local/resource-header?owner_id=7'
  await f.queue.control({ action: 'cachePut', key, value: { ts: 1, data: [{ id: 40, code: 'Resource', title: 'Header', owner_id: 7 }] } })
  const value = await f.queue.control({ action: 'cacheGet', key })
  assert.equal(Array.isArray(value.data), true); assert.equal(value.data[0].title, 'Header')
})

test('a fresh GET committed during a delayed acknowledgement cannot be rolled back by that older ACK', async t => {
  const f = await fixture(t); await f.submit()
  let arrived, release; const held = new Promise(resolve => { arrived = resolve }), gate = new Promise(resolve => { release = resolve }), original = f.session.api
  f.session.api = async (...args) => { const response = await original(...args); if (!args[1].operation.startsWith('GET ')) { arrived(); await gate } return response }
  f.online(); const sending = f.queue.push(); await held
  const fresh = structuredClone(planning); fresh.data.data.processes[0].tasks[0].title = 'New external edit'
  await f.queue.cachePut(base + '/planning/tasks', fresh, { 'process:10': 'external-newer' })
  release(); await sending
  const cached = await f.queue.control({ action: 'cacheGet', key: base + '/planning/tasks' })
  assert.equal(cached.data.data.processes[0].tasks[0].title, 'New external edit')
  assert.equal(cached.data.data.processes[0].tasks[0]._baseline['process:10'], 'external-newer')
  assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('a stale second window cannot borrow the version of a still-pending first window', async t => {
  const f = await fixture(t), baseline = { 'process:10': 'process-v1' }
  await f.submit({ ...mutation('First window'), preconditions: baseline })
  await f.submit({ ...mutation('Unobserved first edit'), preconditions: baseline })
  f.online(); await f.queue.push()
  assert.equal(f.serverRows.get(30).title, 'First window')
  const rows = await f.queue.control({ action: 'list' }); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'conflict')
})
test('an actual projection reader carries proof of its observed predecessor across restart', async t => {
  const f = await fixture(t), first = await f.submit({ ...mutation('Observed first'), preconditions: { 'process:10': 'process-v1' } })
  const cached = await f.queue.control({ action: 'cacheGet', key: base + '/planning/tasks' }), row = cached.data.data.processes[0].tasks[0]
  assert.equal(row._pending['process:10'], first.operationId)
  await f.submit({ ...mutation('Observed second'), preconditions: { 'process:10': 'local:' + row._pending['process:10'] } })
  await f.restart(); f.online(); await f.queue.push()
  assert.equal(f.serverRows.get(30).title, 'Observed second'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
test('an observed local predecessor may already be confirmed before the next intent is submitted', async t => {
  const f = await fixture(t), first = await f.submit({ ...mutation('First'), preconditions: { 'process:10': 'process-v1' } })
  f.online(); await f.queue.push()
  await f.submit({ ...mutation('Causal second'), preconditions: { 'process:10': 'local:' + first.operationId } })
  assert.equal(f.serverRows.get(30).title, 'Causal second'); assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})

test('local causal markers support the maximum durable operation ID without changing the HTTP body schema', () => {
  assert.equal(validMutation({ ...mutation(), preconditions: { 'process:10': 'local:' + 'a'.repeat(128) } }), true)
})
test('local causal proof cannot reference an unknown command or another account namespace', async t => {
  const f = await fixture(t), first = await f.submit()
  await assert.rejects(f.submit({ ...mutation(), preconditions: { 'process:10': 'local:unknown-command' } }), /COMMAND_BASELINE_REQUIRED/)
  f.switchAccount()
  await assert.rejects(f.submit({ ...mutation(), preconditions: { 'process:10': 'local:' + first.operationId } }), /COMMAND_BASELINE_REQUIRED/)
  assert.equal((await f.queue.control({ action: 'list' })).length, 0); assert.equal(f.calls.length, 0)
})

for (const boundary of ['api', 'enqueue']) test('renderer ' + boundary + ' cannot fall back to an unrelated cache baseline', async t => {
  const f = await fixture(t)
  await assert.rejects(boundary === 'api' ? f.queue.api({ operation: 'PUT /task/{id}', path: { id: '30' }, body: { title: 'Blind' } }, () => {}) : f.queue.control({ action: 'enqueue', operationId: randomUUID(), input: mutation('Blind') }), /COMMAND_BASELINE_REQUIRED/)
  assert.equal((await f.queue.control({ action: 'list' })).length, 0); assert.equal(f.calls.length, 0)
})

test('a year offline preserves old commands, their projection and their stable operation identity', async t => {
  const f = await fixture(t), { operationId } = await f.submit()
  await f.queue.stop(); await f.storage.close()
  const { DatabaseSync } = require('node:sqlite'), database = new DatabaseSync(path.join(f.directory, 'clockwork.sqlite'))
  try { database.exec('UPDATE commands SET created_at=1,updated_at=1; UPDATE receipts SET updated_at=1; UPDATE http_cache SET updated_at=1;') } finally { database.close() }
  f.advance(366 * 24 * 60 * 60 * 1000); await f.restart()
  assert.equal((await f.queue.control({ action: 'list' }))[0].operationId, operationId)
  assert.equal((await task(f)).title, 'After')
  f.online(); await f.queue.push()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operationId, operationId)
  assert.equal((await f.queue.control({ action: 'list' })).length, 0)
})
