'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBusinessAdapters } = require('../desktop/business-adapters.cjs')
const { createDesktopService } = require('../desktop/service.cjs')
const { validate } = require('../desktop/protocol.cjs')
function fixture() {
  let identity = { mode: 'online', server: 'https://fixture.test/api/v1', user: { id: 7, preset: 'vp' }, contextId: 'session-a' }
  let result = { status: 200, data: { data: { items: [{ id: 1 }], total: 1 }, error: {} }, baseline: { 'project:1': 'revision-a' } }
  const requests = [], cancellations = [], controls = []
  const session = { status: () => identity, api: async (owner, request) => { requests.push({ owner, ...request }); return typeof result === 'function' ? result() : result }, cancel: (...args) => cancellations.push(args) }
  const queue = { control: async request => { controls.push(request); return result } }
  const adapters = createBusinessAdapters({ session, queue })
  const context = { signal: new AbortController().signal, scope: { server: identity.server, accountId: 7 }, source: 'snapshot', operationId: 'stable-operation', locale: 'ru', preconditions: { 'project:1': 'revision-a' }, temporaryId: -1 }
  return { ...adapters, requests, cancellations, controls, context, identity: patch => { identity = { ...identity, ...patch } }, result: next => { result = next } }
}
test('installs the business catalog before startup and exposes only installed capabilities', () => {
  const f = fixture(), service = createDesktopService({ profileId: 'fixture' })
  service.installAdapters(f); service.start()
  assert(service.status().capabilities.reads.includes('resource.header'))
  assert(service.status().capabilities.commands.includes('comment.create'))
  assert(!service.status().capabilities.commands.includes('task.move'))
  assert.throws(() => service.installAdapters(f), /before startup/)
})
test('typed reads retain source, pagination, baseline and locale without exposing HTTP metadata', async () => {
  const f = fixture(); f.result({ status: 200, data: { data: { items: [], total: 0 } }, localSnapshot: true, baseline: { 'project:1': 'revision-a' }, secret: 'never-cross-ipc' })
  assert.deepEqual(await f.reads['project.list']({ limit: 500, offset: 2 }, f.context), { status: 'ok', data: { items: [], total: 0, limit: 500, offset: 2 }, source: 'snapshot', baseline: { 'project:1': 'revision-a' } })
  assert.equal(f.requests[0].snapshotOnly, true); assert.equal(f.requests[0].locale, 'ru')
  assert.equal(f.requests[0].contextId, 'session-a')
})
test('cold snapshots, denied reads and successful-HTTP domain refusals remain distinct', async () => {
  const f = fixture()
  f.result({ status: 503, data: { error: { code: 'LOCAL_SNAPSHOT_MISSING' } } })
  assert.deepEqual(await f.reads['planning.tasks'](undefined, f.context), { status: 'missing' })
  for (const status of [401, 403, 404, 409, 422, 503]) {
    f.result({ status, data: { error: { code: String(status), message: 'Refused' } } })
    assert.equal((await f.reads['planning.tasks'](undefined, f.context)).status, 'failed')
  }
  f.result({ status: 200, data: { error: { code: 'FORBIDDEN', message: 'Refused' } } })
  assert.equal((await f.reads['planning.tasks'](undefined, f.context)).error.kind, 'forbidden')
})
test('commands preserve the operation, temporary identifier and loaded baseline through the durable boundary', async () => {
  const f = fixture(); f.result({ status: 202, queued: true, operationId: 'stable-operation' })
  const result = await f.commands['task.update']({ id: -1, patch: { responsible_id: null } }, f.context)
  assert.deepEqual(result, { status: 'queued', operationId: 'stable-operation', sessionContextId: 'session-a' })
  assert.deepEqual(f.requests[0].preconditions, { 'project:1': 'revision-a' })
  assert.equal(f.requests[0].tempId, -1); assert.equal(f.requests[0].key, 'stable-operation')
  assert.deepEqual(f.requests[0].body, { responsible_id: null })
})
test('commands distinguish confirmation, refusal, conflict and unknown outcome', async () => {
  const f = fixture()
  for (const [http, status] of [[200, 'confirmed'], [400, 'rejected'], [403, 'rejected'], [409, 'conflict'], [429, 'unknown'], [503, 'unknown']]) {
    f.result({ status: http, data: { data: { id: 1 } } })
    assert.equal((await f.commands['project.delete']({ id: 1 }, f.context)).status, status)
  }
  f.result({ status: 200, data: { error: { code: 'FORBIDDEN' } } })
  assert.equal((await f.commands['project.delete']({ id: 1 }, f.context)).status, 'rejected')
})
test('a switched identity cannot send or accept an old-scope read', async () => {
  const f = fixture(); f.identity({ user: { id: 8, preset: 'admin' } })
  assert.equal((await f.reads['project.list']({}, f.context)).status, 'failed'); assert.equal(f.requests.length, 0)
  f.identity({ user: { id: 7, preset: 'vp' } })
  f.result(() => { f.identity({ contextId: 'session-b' }); return { status: 200, data: { data: {} } } })
  assert.equal((await f.reads['project.list']({}, f.context)).status, 'failed')
})
test('read cancellation reaches main authorization and suppresses late data', async () => {
  const f = fixture(), controller = new AbortController(); let complete
  f.result(() => new Promise(resolve => { complete = resolve }))
  const pending = f.reads['project.list']({}, { ...f.context, signal: controller.signal })
  controller.abort(); complete({ status: 200, data: { data: {} } })
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.cancellations.length, 1)
})
test('resource header owner is enforced for non-admins and optional for admins', async () => {
  const f = fixture(); f.result({ status: 200, data: [{ id: 1, owner_id: 7 }] })
  const result = await f.reads['resource.header']({ ownerId: 999 }, f.context)
  assert.equal(f.controls[0].key, '/local/resource-header?owner_id=7'); assert.equal(result.coverage.completeness, 'complete')
  f.identity({ user: { id: 7, preset: 'admin' } })
  await f.reads['resource.header']({}, f.context); await f.reads['resource.header']({ ownerId: 9 }, f.context)
  assert.equal(f.controls[1].key, '/local/resource-header?owner_id=all'); assert.equal(f.controls[2].key, '/local/resource-header?owner_id=9')
  f.result(null); assert.equal((await f.reads['resource.header']({}, f.context)).status, 'missing')
  f.result({ status: 403 }); assert.equal((await f.reads['resource.header']({}, f.context)).error.kind, 'forbidden')
})
test('IPC accepts loaded revision metadata but rejects malformed or extra transport fields', () => {
  const request = { protocol: 1, kind: 'command', requestId: 'request', contextId: 'context', operationId: 'operation', operation: 'task.update', input: { id: -1, patch: { responsible_id: null } }, preconditions: { 'process:1': 'revision' }, temporaryId: -1, locale: 'ru' }
  assert.equal(validate(request), true)
  for (const patch of [{ preconditions: { 'task:1': 'revision' } }, { preconditions: { 'process:1': '' } }, { temporaryId: 1 }, { locale: 'other' }, { url: 'https://attacker.test' }]) assert.equal(validate({ ...request, ...patch }), false)
})
