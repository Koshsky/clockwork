'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { performance } = require('node:perf_hooks')
const { createStorage } = require('../desktop/storage.cjs')
const { restoreBackup } = require('../desktop/storage-db.cjs')

const scope = { server: 'https://stress.example/api/v1', accountId: 7 }
const identity = row => [row.operationId, row.idempotencyKey, row.operation, row.input, row.dependencies]
const intent = index => ({ operationId: 'stress-' + index, idempotencyKey: 'stress-key-' + index, operation: 'task.update', input: { id: index + 1, patch: { title: 'Durable task ' + index } }, dependencies: index ? ['stress-' + (index - 1)] : [], changes: [] })
async function all(repository) {
  const rows = []
  for (let after = 0; ;) {
    const page = await repository.queue({ limit: 127, after })
    if (!page.length) return rows
    assert(page[0].sequence > after)
    rows.push(...page); after = page.at(-1).sequence
  }
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-storage-stress-')), stores = []
  const open = async target => { const store = await createStorage({ directory: target || directory }); stores.push(store); return store }
  t.after(async () => { for (const store of stores) await store.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { directory, open }
}

// These are local regression ceilings, not throughput guarantees across target machines.
test('1000 dependent intents retain exact identities through pagination, backup, partial confirmation and worker loss', { timeout: 30000 }, async t => {
  const started = performance.now(), { directory, open } = await fixture(t), store = await open(), repository = store.forScope(scope)
  let observed = performance.now(), maxDelay = 0
  const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - observed); observed = now }, 20)
  t.after(() => clearInterval(timer))
  for (let index = 0; index < 1000; index++) await repository.commitLocal(intent(index))
  const queued = await all(repository)
  assert.equal(queued.length, 1000); assert.equal(new Set(queued.map(row => row.operationId)).size, 1000)
  assert.deepEqual(queued.map(row => row.idempotencyKey), Array.from({ length: 1000 }, (_, index) => 'stress-key-' + index))
  assert.equal(queued.filter(row => row.ready).length, 1)
  for (const other of [{ ...scope, accountId: 8 }, { ...scope, server: 'https://another.example/api/v1' }]) assert.deepEqual(await all(store.forScope(other)), [])
  const saved = await store.backup()
  for (let index = 0; index < 40; index++) await repository.settle({ operationId: 'stress-' + index, status: 'confirmed', result: { id: index + 1 } })
  await repository.markAttempt({ operationId: 'stress-40' }); await store.abort()
  const reopened = await open(), data = reopened.forScope(scope), remaining = await all(data)
  assert.deepEqual(remaining.map(identity), queued.slice(40).map(identity))
  assert.equal(remaining[0].status, 'unknown'); assert.equal(remaining[0].attempts, 1); assert.equal(remaining[0].ready, true)
  assert.equal(remaining.filter(row => row.ready).length, 1)
  for (const index of [0, 40, 999]) assert.equal((await data.commitLocal(intent(index))).replayed, true)
  assert.equal((await all(data)).length, 960)
  assert.equal((await data.receipt({ operationId: 'stress-0' })).status, 'confirmed')
  const restored = path.join(directory, 'restored'); await restoreBackup(directory, saved.id, restored)
  const backup = (await open(restored)).forScope(scope), original = await all(backup)
  assert.deepEqual(original.map(identity), queued.map(identity))
  assert.deepEqual(original.map(row => [row.operationId, row.idempotencyKey, row.status]), queued.map(row => [row.operationId, row.idempotencyKey, row.status]))
  clearInterval(timer)
  assert(maxDelay < 1000, 'SQLite durability must not block the parent event loop for a second')
  t.diagnostic(JSON.stringify({ intents: 1000, remaining: remaining.length, elapsedMs: Math.round(performance.now() - started), maxParentTimerDelayMs: Math.round(maxDelay) }))
})

test('the 32 MiB request-byte limit rejects oversized concurrent work before acknowledging it and drains accepted writes', { timeout: 30000 }, async t => {
  const { open } = await fixture(t), store = await open(), repository = store.forScope(scope)
  const data = { parts: Array(48).fill('x'.repeat(60 * 1024)) }
  const requests = Array.from({ length: 12 }, (_, index) => repository.saveSnapshot({ domain: 'planning.tasks', key: 'large-' + index, expectedRevision: 0, data }))
  const outcomes = await Promise.allSettled(requests)
  const accepted = outcomes.flatMap((result, index) => result.status === 'fulfilled' ? [index] : [])
  const rejected = outcomes.flatMap((result, index) => result.status === 'rejected' ? [index] : [])
  assert.equal(accepted.length, 11); assert.equal(rejected.length, 1)
  for (const index of rejected) assert.equal(outcomes[index].reason.code, 'STORAGE_BUSY')
  assert.equal(store.status().phase, 'ready'); assert.equal(await store.close(), true)
  const restarted = (await open()).forScope(scope)
  for (const index of accepted) assert.deepEqual((await restarted.snapshot({ domain: 'planning.tasks', key: 'large-' + index })).data, data)
  for (const index of rejected) assert.equal(await restarted.snapshot({ domain: 'planning.tasks', key: 'large-' + index }), null)
  t.diagnostic(JSON.stringify({ requestCount: requests.length, accepted: accepted.length, rejected: rejected.length, approximatePayloadMiB: data.parts.length * data.parts[0].length / 1024 / 1024 }))
})
