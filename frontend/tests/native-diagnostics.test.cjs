'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createDiagnostics } = require('../desktop/diagnostics.cjs')
const { createStorage } = require('../desktop/storage.cjs')

const state = (id, server = 'https://fixture.invalid/api/v1') => ({ contextId: 'context-' + id, server, user: { id, username: 'private-person' }, mode: 'online' })
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-diagnostics-'))
  const journal = createDiagnostics({ directory, version: '2.2.0', ...options })
  t.after(async () => { await journal.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { directory, journal }
}

test('safe logs survive restart but never mix accounts/servers or export context keys', async t => {
  const { directory, journal } = await fixture(t)
  journal.setContext(state(1))
  journal.record('main', 'http-network', { response: { status: 403, data: { error: { code: 'FORBIDDEN', message: 'private-secret' } } } }, { request_id: 'a'.repeat(32), url: 'private-secret' }, 'failed')
  await journal.flush()
  let report = await journal.report()
  assert.equal(report.records[0].diagnostic.error_code, 'FORBIDDEN')
  assert.equal(report.records[0].diagnostic.request_id, 'a'.repeat(32))
  assert(!JSON.stringify(report).includes('private'))
  const late = journal.bind('queue', 'outbox-send')
  journal.setContext(state(2)); late({ code: 'ERR_NETWORK' }, {}, 'unknown')
  assert.equal((await journal.report()).records.length, 0)
  journal.setContext(state(1, 'https://other.invalid/api/v1'))
  assert.equal((await journal.report()).records.length, 0)
  await journal.close()
  const reopened = createDiagnostics({ directory, version: '2.2.0' })
  reopened.setContext(state(1)); report = await reopened.report(); await reopened.close()
  assert.equal(report.records.length, 1)
  assert(!JSON.stringify(report).includes('context-'))
  assert(!JSON.stringify(report).includes('fixture.invalid'))
})

test('active delivery excludes sleep and pre-delivery offline, but includes a failed in-flight attempt', async t => {
  let clock = 0
  const { journal } = await fixture(t, { monotonic: () => clock })
  journal.setContext(state(1))
  clock = 86400000 // Offline/sleep before sending is not delivery activity.
  const finish = journal.beginDelivery()
  clock += 100; journal.suspend(); clock += 86400000; journal.resume(); clock += 200
  finish('unknown', { code: 'ERR_NETWORK' }); finish('confirmed')
  const report = await journal.report()
  assert.equal(report.delivery.active_ms_current_session, 300)
  assert.equal(report.delivery.outcomes.unknown, 1)
  const old = journal.beginDelivery(); journal.setContext(state(2)); clock += 100; old('confirmed')
  assert.equal((await journal.report()).delivery.active_ms_current_session, 0)
})

test('rotation bounds bytes/retention and resanitizes tampered lines before an export', async t => {
  let now = 1795080000000
  const { directory, journal } = await fixture(t, { diskLimit: 8192, now: () => now })
  journal.setContext(state(1))
  for (let n = 0; n < 150; n++) { journal.record('renderer', 'diagnostic', new Error('private-secret'), { kind: 'component' }, 'failed'); if (n % 16 === 0) await journal.flush() }
  await journal.flush()
  const root = path.join(directory, 'diagnostics')
  const entries = await fs.readdir(root)
  const sizes = await Promise.all(entries.map(name => fs.stat(path.join(root, name))))
  assert(sizes.reduce((sum, info) => sum + info.size, 0) <= 8192)
  const filename = entries.find(name => name.endsWith('.jsonl'))
  await fs.appendFile(path.join(root, filename), '\n{"source":"main","outcome":"failed","secret":"private-secret","diagnostic":{"event":"diagnostic","error_code":"private-secret","stack":"private-secret"}}\n')
  await fs.appendFile(path.join(root, filename), '{"secret":"private-secret') // Interrupted final JSONL record.
  assert(!JSON.stringify(await journal.report()).includes('private-secret'))
  now += 8 * 86400000
  assert.equal((await journal.report()).records.length, 0)
})

test('diagnostic storage failure leaves a bounded memory report and does not block SQLite commands', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-diagnostics-failed-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'diagnostics'), 'not a directory')
  const journal = createDiagnostics({ directory, version: '2.2.0' })
  journal.setContext(state(1))
  const storage = await createStorage({ directory, diagnostics: journal })
  try {
    const repository = storage.forScope({ server: state(1).server, accountId: 1 })
    await repository.commitLocal({ operationId: 'fixture-op', operation: 'task.update', input: { id: 1, patch: { color: '#112233' } }, idempotencyKey: 'fixture-key', dependencies: [], changes: [] })
    assert.equal((await repository.queueStats()).pending, 1)
    for (let n = 0; n < 200; n++) journal.record('worker', 'diagnostic', { code: 'STORAGE_FULL' }, {}, 'failed')
    const report = await journal.report()
    assert.equal(report.journal.status, 'unavailable'); assert.equal(report.records.length, 50)
    assert.equal((await repository.queue({ limit: 4, after: 0 })).length, 1)
    await storage.abort()
    assert.equal((await journal.report()).records.at(-1).diagnostic.error_code, 'STORAGE_UNAVAILABLE')
    const restarted = await createStorage({ directory, diagnostics: journal })
    try { assert.equal((await restarted.forScope({ server: state(1).server, accountId: 1 }).queueStats()).pending, 1) } finally { await restarted.close() }
  } finally { await storage.close(); await journal.close() }
})

test('queue aggregate counts only the selected scope, pending dependencies and known outcomes', async t => {
  const { directory } = await fixture(t)
  const store = await createStorage({ directory })
  try {
    const repo = store.forScope({ server: state(1).server, accountId: 1 })
    for (const [id, dependencies] of [['first', []], ['second', ['first']]]) await repo.commitLocal({ operationId: id, operation: 'task.update', input: { id: 1, patch: { color: '#112233' } }, idempotencyKey: 'key-' + id, dependencies, changes: [] })
    let stats = await repo.queueStats()
    assert.equal(stats.pending, 2); assert.equal(stats.ready, 1); assert.equal(stats.blocked, 1)
    await repo.markAttempt({ operationId: 'first' })
    stats = await repo.queueStats(); assert.equal(stats.unknown, 1)
    await repo.settle({ operationId: 'first', status: 'confirmed', result: {}, mappings: [], changes: [] })
    stats = await repo.queueStats(); assert.equal(stats.pending, 1); assert.equal(stats.blocked, 0); assert.equal(stats.ready, 1)
    await repo.markAttempt({ operationId: 'second' })
    await repo.settle({ operationId: 'second', status: 'conflict', result: {}, mappings: [], changes: [] })
    stats = await repo.queueStats(); assert.equal(stats.conflict, 1); assert.equal(stats.pending, 0)
    assert.equal((await store.forScope({ server: state(1).server, accountId: 2 }).queueStats()).total, 0)
    assert.equal((await store.forScope({ server: 'https://other.invalid/api/v1', accountId: 1 }).queueStats()).total, 0)
    assert(!JSON.stringify(stats).includes('operationId'))
  } finally { await store.close() }
})

test('a burst uses bounded batched writes and an explicit preview flushes pending records', async t => {
  const nativeFs = require('node:fs'), { journal } = await fixture(t)
  const append = nativeFs.appendFileSync
  let writes = 0
  nativeFs.appendFileSync = (...args) => { writes++; return append(...args) }
  try {
    journal.setContext(state(1))
    for (let index = 0; index < 64; index++) journal.record('main', 'diagnostic', null, {}, 'observed')
    assert.equal(writes, 0)
    const report = await journal.report()
    assert.equal(report.records.length, 64); assert.equal(writes, 4)
  } finally { nativeFs.appendFileSync = append }
})
