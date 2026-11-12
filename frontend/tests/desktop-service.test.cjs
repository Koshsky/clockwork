'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { validate, readOperations, commandOperations } = require('../desktop/protocol.cjs')
const { createDesktopService } = require('../desktop/service.cjs')
const { createDesktopIpc, REQUEST, EVENT } = require('../desktop/ipc.cjs')
const { loadProfile } = require('../desktop/profile.cjs')
const { startDesktop } = require('../desktop/application.cjs')
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const service = createDesktopService({ profileId: 'profile', version: '1.6.3', electron: 'fixture', ...options })
  service.start(); service.setScope({ server: 'https://erp.example/api/v1', accountId: 7 })
  return service
}
function read(service, requestId = 'read-1', input = undefined) { return { protocol: 1, kind: 'read', requestId, contextId: service.status().context.id, operation: 'planning.tasks', input, source: 'refresh' } }
function command(service, operationId = 'operation-1', input = { id: 1, patch: { title: 'Saved' } }) { return { protocol: 1, kind: 'command', requestId: 'request-' + operationId, contextId: service.status().context.id, operationId, operation: 'task.update', input } }
const okRead = { status: 'ok', data: { processes: [] }, source: 'refresh' }
const okCommand = { status: 'confirmed', data: { id: 1, title: 'Saved' } }

const validInputs = {
  'project.list': {}, 'resource.list': { ownerId: 7 }, 'resource.members': { resourceId: -1 }, 'resource.calendar': { start: '2026-11-01', end: '2026-11-30' },
  'resource.absences': { resourceId: 1, start: '2026-11-01', end: '2026-11-30' }, 'employee.list': { staffOnly: true },
  'timesheet.periods': { employeeIds: [7], start: '2026-11-01', end: '2026-11-30' }, 'account.list': { limit: 500 }, 'rbac.user': { userId: 7 }, 'comment.list': { taskId: 1 }, 'assignment.list': { taskId: 1 }, 'audit.events': { search: 'fixture' },
  'task.move': { id: 1, start: '2026-11-01', end: '2026-11-30' }, 'dependency.create': { taskId: 1, dependency: { depends_on_task_id: 2, type: 'fs' } },
  'dependency.update': { id: 1, patch: { type: 'ss' } }, 'dependency.delete': { id: 1 }, 'assignment.create': { task_id: 1, resource_id: 2, quantity: 3 }, 'assignment.delete': { id: 1 },
  'resource.addMember': { resourceId: 1, userId: 7 }, 'resource.removeMember': { resourceId: 1, userId: 7 },
  'timesheet.assignRange': { userId: 7, stateId: 1, start: '2026-11-01', end: '2026-11-30' }, 'timesheet.clearRange': { userId: 7, start: '2026-11-01', end: '2026-11-30' },
  'project.reorder': { ids: [1, 2] }, 'process.reorder': { projectId: 1, ids: [1, 2] }, 'task.reorder': { processId: 1, ids: [1, 2] },
  'comment.create': { taskId: 1, comment: { content: 'Stored text', parent_id: 2 } }, 'comment.delete': { id: 1 },
  'account.create': { username: 'fixture', permissions: [{ resource: 'task', action: 'view', granted: false }] }, 'account.update': { id: 7, patch: { first_name: 'Fixture' } },
  'account.delete': { id: 7 }, 'account.setManager': { id: 7, managerId: null }, 'rbac.upsertRule': { preset: 'vp', resource: 'task', action: 'view', scope: 'all' },
  'rbac.deleteRule': { id: 1 }, 'rbac.createPreset': { tag: 'fixture', name: 'Fixture' }, 'rbac.updatePreset': { tag: 'fixture', patch: { description: 'Fixture' } }, 'rbac.deletePreset': { tag: 'fixture' },
  'rbac.saveUser': { userId: 7, permissions: { overrides: [{ resource: 'task', action: 'view', granted: false }] } }, 'rbac.reset': undefined,
  'template.save': { enabled: true, processes: [{ title: 'Process', tasks: [{ title: 'Task', resources: [{ resource_id: 1, quantity: 2 }], operations: [{ title: 'Operation' }] }] }] },
}
for (const entity of ['project', 'process', 'task', 'milestone', 'resource', 'state']) {
  validInputs[entity + '.create'] = {}
  validInputs[entity + '.update'] = { id: -1, patch: {} }
  validInputs[entity + '.delete'] = { id: -1 }
}
test('all 67 declared read/command operations have usable bounded schemas', () => {
  for (const [kind, names] of [['read', readOperations], ['command', commandOperations]]) for (const operation of names) {
    const request = { protocol: 1, kind, requestId: 'request', contextId: 'context', operation, input: validInputs[operation], ...(kind === 'read' ? { source: 'snapshot' } : { operationId: 'operation' }) }
    assert.equal(validate(request), true, operation)
  }
})
test('rejects unknown operations, native handles, paths, URLs and SQL instead of forwarding them', () => {
  for (const operation of ['__proto__', 'constructor', 'fetch', 'sql', 'file.read', 'session.token']) assert.equal(validate({ ...command(fixture()), operation }), false)
  for (const input of [{ path: '/private/secret' }, { url: 'https://attacker.example' }, { sql: 'SELECT * FROM users' }]) assert.equal(validate({ ...command(fixture()), input }), false)
})
test('rejects extra envelope fields, protocol skew and invalid identifiers', () => {
  const request = command(fixture())
  for (const patch of [{ protocol: 2 }, { accountId: 999 }, { profile: '../another' }, { contextId: '' }, { operationId: 'x'.repeat(129) }, { requestId: [] }, { source: 'refresh' }]) assert.equal(validate({ ...request, ...patch }), false)
})
test('rejects malformed scalar and nested DTO fields before calling an adapter', () => {
  const request = command(fixture())
  for (const input of [{ id: '1', patch: {} }, { id: NaN, patch: {} }, { id: 0, patch: {} }, { id: 1, patch: { color: [] } }, { id: 1, patch: { end_date: '2026-02-31' } }, { id: 1, patch: { start_date: '2026-99-99' } }]) assert.equal(validate({ ...request, input }), false)
  assert.equal(validate({ ...request, operation: 'account.update', input: { id: 7, patch: { password_hash: 'secret' } } }), false)
  assert.equal(validate({ ...request, operation: 'rbac.saveUser', input: { userId: 7, permissions: { overrides: [{ resource: 'task', action: 'view', granted: 'yes' }] } } }), false)
})
test('bounds bytes, array counts, depth, cycles and prototype keys', () => {
  const request = command(fixture()); let deep = {}; for (let i = 0; i < 20; i++) deep = { child: deep }
  const cyclic = {}; cyclic.self = cyclic
  for (const input of [deep, cyclic, JSON.parse('{"__proto__":{"polluted":true}}'), { id: 1, patch: { title: 'x'.repeat(65537) } }]) assert.equal(validate({ ...request, input }), false)
  assert.equal(validate({ ...request, operation: 'project.reorder', input: { ids: Array(5001).fill(1) } }), false)
  assert.equal(validate({ ...request, operation: 'template.save', input: { processes: Array.from({ length: 25 }, () => ({ title: 'x'.repeat(60000) })) } }), false)
})
test('metadata requests cannot smuggle account or request data', () => {
  assert.equal(validate({ protocol: 1, kind: 'status' }), true)
  assert.equal(validate({ protocol: 1, kind: 'status', input: {} }), false)
  assert.equal(validate({ protocol: 1, kind: 'ack', subscriptionId: 'sub', revision: -1 }), false)
})
test('capabilities expose installed adapters only; missing scope and adapters fail explicitly', async () => {
  const service = createDesktopService({ profileId: 'profile' }); service.start()
  assert.equal((await service.read('owner', read(fixture()))).status, 'failed')
  service.setScope({ server: 'https://erp.example/api', accountId: 7 })
  assert.deepEqual(service.status().capabilities, { reads: [], commands: [] })
  assert.equal((await service.execute('owner', command(service))).status, 'rejected')
})
test('returns a cloned read result and keeps current server/account context outside caller input', async () => {
  let received
  const service = fixture({ reads: { 'planning.tasks': (_, options) => { received = options; return okRead } } })
  const result = await service.read('owner', read(service)); result.data.processes.push({ id: 1 })
  assert.deepEqual(okRead.data.processes, []); assert.equal(received.scope.accountId, 7); assert.equal(received.scope.server, 'https://erp.example/api/v1')
})
test('late reads cannot cross an account/server switch', async () => {
  const held = defer(), service = fixture({ reads: { 'planning.tasks': () => held.promise } })
  const result = service.read('owner', read(service)); service.setScope({ server: 'https://other.example/api', accountId: 7 }); held.resolve(okRead)
  assert.equal((await result).status, 'cancelled')
})
test('a leaving renderer cancels only its reads', async () => {
  const held = defer(), service = fixture({ reads: { 'planning.tasks': () => held.promise } })
  const first = service.read('first', read(service)), second = service.read('second', read(service))
  service.detach('first'); assert.equal((await first).status, 'cancelled'); held.resolve(okRead); assert.equal((await second).status, 'ok')
})
test('only the requesting document can cancel its read', async () => {
  const service = fixture({ reads: { 'planning.tasks': () => new Promise(() => {}) } }), request = read(service)
  const result = service.read('first', request)
  assert.equal(service.cancel('second', request.requestId), false); assert.equal(service.cancel('first', request.requestId), true)
  assert.equal((await result).status, 'cancelled')
})
test('a read timeout releases its slot even when an adapter ignores cancellation', async () => {
  const service = fixture({ readTimeoutMs: 5, reads: { 'planning.tasks': () => new Promise(() => {}) } })
  assert.equal((await service.read('owner', read(service))).status, 'cancelled'); assert.equal(service.status().running, 0)
})
test('an accepted command survives its originating renderer closing', async () => {
  const held = defer(); let calls = 0
  const service = fixture({ commands: { 'task.update': () => { calls++; return held.promise } } })
  const first = service.execute('first', command(service)); service.detach('first')
  const retry = service.execute('second', command(service)); await tick(); assert.equal(calls, 1)
  held.resolve(okCommand); assert.equal((await first).status, 'confirmed'); assert.deepEqual(await retry, await first)
})
test('same operation ID with a different payload never executes twice', async () => {
  let calls = 0; const service = fixture({ commands: { 'task.update': () => { calls++; return okCommand } } })
  await service.execute('first', command(service))
  assert.equal((await service.execute('second', command(service, 'operation-1', { id: 2, patch: {} }))).status, 'conflict'); assert.equal(calls, 1)
})
test('read cancellation cannot cancel an accepted command', async () => {
  const held = defer(), service = fixture({ commands: { 'task.update': () => held.promise } }), request = command(service)
  const result = service.execute('owner', request); assert.equal(service.cancel('owner', request.requestId), false); held.resolve(okCommand); assert.equal((await result).status, 'confirmed')
})
test('command timeout reports unknown while service-owned work continues to its receipt', async () => {
  const held = defer(); let calls = 0
  const service = fixture({ commandTimeoutMs: 5, commands: { 'task.update': () => { calls++; return held.promise } } })
  assert.equal((await service.execute('owner', command(service))).status, 'unknown'); assert.equal(service.status().running, 1)
  held.resolve(okCommand); await tick(); assert.equal((await service.execute('second', command(service))).status, 'confirmed'); assert.equal(calls, 1)
})
test('per-window backpressure leaves room for another window', async () => {
  const held = defer(), service = fixture({ maxPerOwner: 1, reads: { 'planning.tasks': () => held.promise } })
  const first = service.read('first', read(service, 'a')); assert.equal((await service.read('first', read(service, 'b'))).error.code, 'DESKTOP_BUSY')
  const second = service.read('second', read(service, 'c')); held.resolve(okRead); assert.equal((await first).status, 'ok'); assert.equal((await second).status, 'ok')
})
test('total backpressure bounds work across all windows', async () => {
  const held = defer(), service = fixture({ maxPending: 1, reads: { 'planning.tasks': () => held.promise } })
  const first = service.read('first', read(service)); assert.equal((await service.read('second', read(service))).error.code, 'DESKTOP_BUSY'); held.resolve(okRead); await first
})
test('duplicate request IDs do not replace a cancellable read', async () => {
  const held = defer(), service = fixture({ reads: { 'planning.tasks': () => held.promise } })
  const first = service.read('owner', read(service)); assert.equal((await service.read('owner', read(service))).error.code, 'DESKTOP_REQUEST_ID_IN_USE'); held.resolve(okRead); await first
})
test('logout aborts old work without returning old-account success', async () => {
  const held = defer(), service = fixture({ commands: { 'task.update': () => held.promise } })
  const pending = service.execute('owner', command(service)); service.setScope(null); held.resolve(okCommand)
  assert.equal((await pending).status, 'unknown'); assert.equal(service.status().context, null)
})
test('adapter errors and malformed results never expose local exception details', async () => {
  const service = fixture({ reads: { 'planning.tasks': () => { throw new Error('/private/profile/password') } }, commands: { 'task.update': () => ({ status: 'confirmed' }) } })
  assert.deepEqual((await service.read('owner', read(service))).error, { kind: 'unavailable', code: 'DESKTOP_READ_FAILED', message: 'DESKTOP_READ_FAILED' })
  assert.equal((await service.execute('owner', command(service))).status, 'unknown')
})
test('one-time account responses are not retained as replay receipts', async () => {
  let calls = 0; const service = fixture({ commands: { 'account.create': () => { calls++; return { status: 'confirmed', data: { password: 'one-time' } } } } })
  const request = { ...command(service), operation: 'account.create', input: {} }
  await service.execute('owner', request); const repeated = await service.execute('owner', request); assert.equal(calls, 1); assert.equal(repeated.error.code, 'DESKTOP_RESULT_NOT_REPLAYABLE'); assert.equal(JSON.stringify(repeated).includes('one-time'), false)
})
test('graceful shutdown drains accepted commands and rejects new work', async () => {
  const held = defer(), service = fixture({ commands: { 'task.update': () => held.promise } })
  const pending = service.execute('owner', command(service)); const stopped = service.stop()
  assert.equal(service.status().phase, 'stopping'); assert.equal((await service.execute('owner', command(service, 'new'))).status, 'rejected')
  held.resolve(okCommand); assert.equal((await pending).status, 'confirmed'); assert.equal(await stopped, true); assert.equal(service.status().phase, 'stopped')
})
test('stuck shutdown is bounded and reports failure rather than successful persistence', async () => {
  const service = fixture({ commandTimeoutMs: 10, commands: { 'task.update': () => new Promise(() => {}) } })
  const pending = service.execute('owner', command(service)); assert.equal(await service.stop(5), false); assert.equal(service.status().phase, 'failed'); assert.equal((await pending).status, 'unknown')
})
test('service restart changes instance/context identity without changing its profile', () => {
  const first = fixture(), second = fixture(); assert.equal(first.status().profileId, second.status().profileId); assert.notEqual(first.status().instanceId, second.status().instanceId); assert.notEqual(first.status().context.id, second.status().context.id)
  assert.throws(() => first.start()); assert.throws(() => first.setScope({ server: 'file:///private', accountId: 7 }))
})

function ipcFixture(session) {
  const handlers = new Map(), ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }
  const service = fixture(), host = createDesktopIpc({ ipcMain, service, origin: 'http://127.0.0.1:31880', session })
  const contents = new EventEmitter(); contents.id = 1; contents.mainFrame = { url: 'http://127.0.0.1:31880/planner' }; contents.isDestroyed = () => false; contents.sent = []; contents.send = (channel, value) => contents.sent.push({ channel, value })
  host.attach(contents)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const send = request => handlers.get(REQUEST)(event, { protocol: 1, ...request })
  return { service, host, contents, event, handlers, send }
}
test('IPC rejects foreign windows, subframes, remote URLs and destroyed senders', async () => {
  const f = ipcFixture(), handler = f.handlers.get(REQUEST), request = { protocol: 1, kind: 'status' }
  for (const event of [{ sender: { ...f.contents, id: 2 }, senderFrame: f.contents.mainFrame }, { ...f.event, senderFrame: { url: f.contents.mainFrame.url } }]) assert.equal((await handler(event, request)).error.kind, 'forbidden')
  for (const url of ['https://attacker.example', 'about:blank', 'http://127.0.0.1:31881', 'http://user:password@127.0.0.1:31880']) { f.contents.mainFrame.url = url; assert.equal((await handler(f.event, request)).error.kind, 'forbidden') }
  f.host.dispose()
})
test('legacy version IPC uses the same sender guard', () => {
  const f = ipcFixture(), version = f.handlers.get('erp:app-version'); assert.equal(version(f.event).version, '1.6.3'); assert.throws(() => version({ ...f.event, senderFrame: {} })); f.host.dispose()
})
test('IPC validation prevents adapter calls and never accepts caller profile/account selection', async () => {
  const f = ipcFixture(); assert.equal((await f.send({ ...command(f.service), profileId: 'other' })).error.kind, 'validation'); assert.equal((await f.send({ kind: 'status', accountId: 999 })).error.kind, 'validation'); f.host.dispose()
})
test('a slow subscriber gets one outstanding snapshot and then the latest revision', async () => {
  const f = ipcFixture(); await f.send({ kind: 'subscribe', subscriptionId: 'sub' }); assert.equal(f.contents.sent.length, 1)
  const first = f.contents.sent[0].value.state.revision
  for (let i = 0; i < 100; i++) f.service.setScope({ server: 'https://erp.example/api', accountId: 7 })
  assert.equal(f.contents.sent.length, 1)
  await f.send({ kind: 'ack', subscriptionId: 'sub', revision: first + 1 }); assert.equal(f.contents.sent.length, 1)
  await f.send({ kind: 'ack', subscriptionId: 'sub', revision: first }); assert.equal(f.contents.sent.length, 2)
  assert.equal(f.contents.sent[1].channel, EVENT); assert.equal(f.contents.sent[1].value.state.revision, f.service.status().revision); f.host.dispose()
})
test('unsubscribe, navigation and renderer crash release event subscriptions', async () => {
  const f = ipcFixture(); await f.send({ kind: 'subscribe', subscriptionId: 'old' }); await f.send({ kind: 'unsubscribe', subscriptionId: 'old' })
  f.service.setScope(null); assert.equal(f.contents.sent.length, 1)
  await f.send({ kind: 'subscribe', subscriptionId: 'new' }); f.contents.emit('did-start-navigation', {}, '/planner', false, true)
  f.service.setScope(null); assert.equal(f.contents.sent.length, 2)
  await f.send({ kind: 'subscribe', subscriptionId: 'crash' }); f.contents.emit('render-process-gone'); f.service.setScope(null); assert.equal(f.contents.sent.length, 3)
  f.host.dispose(); assert.equal(f.handlers.size, 0)
})
test('profile identity persists across application instances and differs across profiles', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const first = await loadProfile(directory); assert.equal(await loadProfile(directory), first); assert.notEqual(await loadProfile(path.join(directory, 'other')), first)
})
test('corrupt profile metadata is reported and never overwritten', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'desktop-service.json'), 'corrupt'); await assert.rejects(loadProfile(directory)); assert.equal(await fs.readFile(path.join(directory, 'desktop-service.json'), 'utf8'), 'corrupt')
})
test('unsupported metadata versions and unavailable profile directories fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-profile-')); t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'desktop-service.json'), JSON.stringify({ version: 99, id: 'unknown' })); await assert.rejects(loadProfile(directory))
  const file = path.join(directory, 'file'); await fs.writeFile(file, 'keep'); await assert.rejects(loadProfile(file)); assert.equal(await fs.readFile(file, 'utf8'), 'keep')
})
test('failed single-instance lock quits before startup even without a SingletonLock file', async () => {
  const app = { requestSingleInstanceLock: () => false, quit: () => { app.quits++ }, quits: 0, whenReady: () => { throw new Error('Startup must not run') } }
  assert.equal(await startDesktop({ app }, { webDir: '/nonexistent' }).ready, null); assert.equal(app.quits, 1)
})

const { attachRendererRecovery } = require('../desktop/renderer-recovery.cjs')
function recoveryFixture() {
  const contents = new EventEmitter(), loaded = [], failures = []
  let time = 0, active = true
  contents.isDestroyed = () => false; contents.getURL = () => 'http://127.0.0.1:31880/planner?view=week'; contents.loadURL = async url => { loaded.push(url) }
  const stop = attachRendererRecovery(contents, { origin: 'http://127.0.0.1:31880', active: () => active, now: () => time, onFailed: () => failures.push(true) })
  return { contents, loaded, failures, stop, advance: () => { time += 30001 }, deactivate: () => { active = false } }
}
test('renderer recovery preserves the current local route and limits crash loops', async () => {
  const f = recoveryFixture()
  for (let i = 0; i < 3; i++) f.contents.emit('render-process-gone', {}, { reason: 'crashed' })
  await tick()
  assert.deepEqual(f.loaded, ['http://127.0.0.1:31880/planner?view=week', 'http://127.0.0.1:31880/planner?view=week']); assert.equal(f.failures.length, 1)
  f.advance(); f.contents.emit('render-process-gone', {}, { reason: 'oom' }); await tick(); assert.equal(f.loaded.length, 3); f.stop()
})
test('renderer recovery never reloads external content with a privileged preload', async () => {
  const f = recoveryFixture(); f.contents.getURL = () => 'https://attacker.example'; f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await tick(); assert.deepEqual(f.loaded, ['http://127.0.0.1:31880']); f.stop()
})
test('clean exit, shutdown and destroyed windows do not restart a renderer', () => {
  const f = recoveryFixture(); f.contents.emit('render-process-gone', {}, { reason: 'clean-exit' }); f.deactivate(); f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); assert.equal(f.loaded.length, 0)
  f.contents.emit('destroyed'); assert.equal(f.contents.listenerCount('render-process-gone'), 0)
})
test('a failed renderer reload reports failure without an unhandled rejection', async () => {
  const f = recoveryFixture(); f.contents.loadURL = async () => { throw new Error('Load failed') }; f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await tick(); assert.equal(f.failures.length, 1); f.stop()
})

const vm = require('node:vm')
const { readFileSync } = require('node:fs')
function preloadFixture() {
  const renderer = new EventEmitter(), sent = []
  renderer.invoke = async (channel, request) => { sent.push({ channel, request }); return { ok: true, value: null } }
  const context = vm.createContext({ TextEncoder, console, crypto: require('node:crypto').webcrypto, require: name => {
    assert.equal(name, 'electron')
    return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (_, bridge) => { context.bridge = bridge } } }
  } })
  vm.runInContext(readFileSync(path.join(__dirname, '../desktop/preload.js'), 'utf8'), context)
  return { context, renderer, sent, evaluate: expression => vm.runInContext(expression, context) }
}
test('preload exposes only narrow bridge methods, never Electron events or raw invocation', () => {
  const f = preloadFixture()
  assert.deepEqual(Object.keys(f.context.bridge).sort(), ['appVersion', 'isElectron', 'service', 'session'])
  assert.deepEqual(Object.keys(f.context.bridge.service).sort(), ['cancel', 'execute', 'read', 'status', 'subscribe'])
})
test('preload rejects oversized trees before serializing IPC to main', async () => {
  const f = preloadFixture(), result = await f.evaluate("bridge.service.execute({ operation:'task.update', input: { id:1, patch:{title:'x'.repeat(65537)} } })")
  assert.equal(result.status, 'rejected'); assert.equal(f.sent.length, 0)
})
test('preload owns protocol and method fields even if a page tries to override them', async () => {
  const f = preloadFixture(); await f.evaluate("bridge.service.read({ protocol:999,kind:'command',operation:'planning.tasks',requestId:'r',contextId:'c',source:'refresh' })")
  assert.equal(f.sent[0].request.protocol, 1); assert.equal(f.sent[0].request.kind, 'read')
})
test('preload delivers data without the native event and acknowledges even a throwing listener', async () => {
  const f = preloadFixture(); f.evaluate("bridge.service.subscribe(state => { globalThis.received = state; throw new Error('Listener failed') })")
  const subscriptionId = f.sent[0].request.subscriptionId
  f.renderer.emit(EVENT, { sender: { privileged: true } }, { subscriptionId, state: { revision: 7, phase: 'ready' } })
  assert.equal(f.context.received.phase, 'ready'); assert.equal(f.context.received.sender, undefined)
  assert.equal(f.sent.at(-1).request.kind, 'ack'); assert.equal(f.sent.at(-1).request.revision, 7)
})
test('identical listener callbacks have independent subscriptions and cleanly unsubscribe', () => {
  const f = preloadFixture(); f.evaluate('globalThis.listener=()=>{}; globalThis.a=bridge.service.subscribe(listener); globalThis.b=bridge.service.subscribe(listener)')
  assert.equal(f.sent.filter(item => item.request.kind === 'subscribe').length, 1)
  f.evaluate('a()'); assert.equal(f.sent.filter(item => item.request.kind === 'unsubscribe').length, 0)
  f.evaluate('b(); b()'); assert.equal(f.sent.filter(item => item.request.kind === 'unsubscribe').length, 1)
})
test('packaging includes every local runtime dependency and excludes test-only adapters', () => {
  const desktop = path.join(__dirname, '../desktop'), pkg = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')), visited = new Set()
  function visit(name) {
    if (visited.has(name)) return
    visited.add(name); assert.ok(pkg.build.files.includes(name), name)
    if (!name.endsWith('.json')) for (const match of readFileSync(path.join(desktop, name), 'utf8').matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) visit(match[1])
  }
  visit('main.js'); visit('preload.js')
  assert.ok(visited.has('ipc.cjs')); assert.ok(visited.has('renderer-recovery.cjs'))
  assert.ok(pkg.build.files.every(file => !file.includes('tests/')))
})
test('reloading one window cannot bypass its pending-work budget and starve another window', async () => {
  const held = defer(), service = fixture({ maxPerOwner: 1, commands: { 'task.update': () => held.promise } })
  const first = service.execute('1:0', command(service))
  assert.equal((await service.execute('1:1', command(service, 'another'))).error.code, 'DESKTOP_BUSY')
  const other = service.execute('2:0', command(service, 'independent')); held.resolve(okCommand)
  assert.equal((await first).status, 'confirmed'); assert.equal((await other).status, 'confirmed')
})
test('scope changes during completion notification cannot leak a final read or command reply', async () => {
  for (const kind of ['read', 'command']) {
    const service = fixture({ reads: { 'planning.tasks': () => okRead }, commands: { 'task.update': () => okCommand } })
    let seen = false, switched = false
    service.subscribe(state => {
      if (state.running) seen = true
      if (seen && !state.running && !switched) { switched = true; service.setScope(null) }
    })
    const result = kind === 'read' ? await service.read('owner', read(service)) : await service.execute('owner', command(service))
    assert.equal(result.status, kind === 'read' ? 'cancelled' : 'unknown'); assert.equal(result.data, undefined)
  }
})
test('session IPC uses the same registered top-frame and origin guard as data operations',async()=>{
  const f=ipcFixture({subscribe:()=>()=>{},detach:()=>{},status:()=>({revision:1,mode:'signedOut'})}),handler=f.handlers.get('erp:session')
  assert.equal((await handler(f.event,{action:'status'})).ok,true)
  assert.equal((await handler({...f.event,senderFrame:{}},{action:'login',username:'u',password:'p'})).error,'DESKTOP_UNTRUSTED_SENDER')
  f.contents.mainFrame.url='https://evil.example'
  assert.equal((await handler(f.event,{action:'status'})).error,'DESKTOP_UNTRUSTED_SENDER');f.host.dispose()
})
test('session notifications coalesce behind one acknowledgement and discard stale document acknowledgements',async()=>{
  let notify,revision=1
  const f=ipcFixture({subscribe:cb=>{notify=cb;return()=>{}},detach:()=>{},status:()=>({revision,mode:'online'})})
  for(let index=0;index<100;index++){revision++;notify()}
  assert.equal(f.contents.sent.length,1)
  const ack=f.handlers.get('erp:session')
  await ack(f.event,{action:'ack',revision:2});assert.equal(f.contents.sent.length,2);assert.equal(f.contents.sent[1].value.revision,101)
  f.contents.emit('did-start-navigation',{},'/planner',false,true)
  await ack(f.event,{action:'ack',revision:101});assert.equal(f.contents.sent.length,2)
  f.host.dispose()
})
