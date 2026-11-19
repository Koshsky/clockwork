'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path'), os = require('node:os')
const { createDiagnostics } = require('../desktop/diagnostics.cjs')
const { createDiagnosticsIpc, CHANNEL } = require('../desktop/diagnostics-ipc.cjs')

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-diag-ipc-'))
  const journal = createDiagnostics({ directory, version: '2.2.0' })
  const state = { contextId: 'own', server: 'https://private.invalid/api/v1', mode: 'offline', user: { id: 7, name: 'private-person' } }
  journal.setContext(state)
  const handlers = new Map(), listeners = new Set()
  const window = { document: 0, contents: { id: 1, isDestroyed: () => false } }
  const file = path.join(directory, 'report.json')
  const session = { status: () => structuredClone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  let chooser = async () => ({ filePath: file, canceled: false }), calls = 0
  const service = { status: () => ({ storage: { phase: 'ready', path: 'private-path' }, sync: { reachable: false, lastPullAt: 1, user: 'private-person' } }) }
  const storage = { forScope(scope) { assert.equal(scope.accountId, 7); return { queueStats: async () => ({ total: 3, pending: 2, ready: 1, blocked: 1, retry_waiting: 0, unknown: 1, conflict: 1, rejected: 0, retries: 1, oldest_created_at: 1, raw: 'private-person' }) } } }
  const bridge = createDiagnosticsIpc({ ipcMain: { handle(key, fn) { handlers.set(key, fn) }, removeHandler(key) { handlers.delete(key) } },
    trusted: event => event === 'trusted' ? window : null, session, service, storage, journal, version: '2.2.0',
    showSaveDialog: (...args) => { calls++; return chooser(...args) } })
  const invoke = request => handlers.get(CHANNEL)('trusted', { contextId: state.contextId, ...request })
  t.after(async () => { bridge.dispose(); await journal.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { journal, storage, state, window, file, invoke, handlers, setChooser: fn => { chooser = fn }, calls: () => calls, change() { state.contextId = 'other'; journal.setContext(state); for (const listener of listeners) listener() } }
}

test('preview contains only safe current aggregates; saved bytes exactly match what was previewed', async t => {
  const f = await fixture(t)
  f.journal.record('main', 'http-network', new Error('private-person'), {}, 'failed')
  const preview = await f.invoke({ action: 'preview' })
  assert.equal(preview.ok, true); assert.equal(f.calls(), 0)
  assert.equal(preview.value.report.state.queue.blocked, 1)
  assert(!JSON.stringify(preview.value.report).includes('private'))
  f.journal.record('main', 'diagnostic', null, {}, 'ready')
  const result = await f.invoke({ action: 'save', snapshotId: preview.value.snapshotId })
  assert.equal(result.value.saved, true)
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), preview.value.report)
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600)
})

test('foreign context/sender, arbitrary paths and oversized reports cannot trigger a save', async t => {
  const f = await fixture(t)
  assert.equal((await f.handlers.get(CHANNEL)('foreign', { action: 'preview' })).ok, false)
  assert.equal((await f.invoke({ action: 'preview', contextId: 'other' })).ok, false)
  assert.equal((await f.invoke({ action: 'save', filePath: f.file, snapshotId: 'anything' })).ok, false)
  assert.equal((await f.invoke({ action: 'record', kind: 'pdf', diagnostic: { message: 'x'.repeat(5000) } })).ok, false)
  assert.equal(f.calls(), 0)
})

test('native cancel and account change while choosing a file never write or mix reports', async t => {
  const f = await fixture(t)
  const preview = await f.invoke({ action: 'preview' })
  f.setChooser(async () => ({ canceled: true }))
  assert.equal((await f.invoke({ action: 'save', snapshotId: preview.value.snapshotId })).value.saved, false)
  f.setChooser(async () => { f.change(); return { canceled: false, filePath: f.file } })
  assert.equal((await f.invoke({ action: 'save', snapshotId: preview.value.snapshotId, contextId: 'own' })).ok, false)
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
})

test('save failure never overwrites an existing file or changes the journal', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.file, 'existing-user-file')
  const preview = await f.invoke({ action: 'preview' })
  assert.equal((await f.invoke({ action: 'save', snapshotId: preview.value.snapshotId })).ok, false)
  assert.equal(await fs.readFile(f.file, 'utf8'), 'existing-user-file')
  assert.equal((await f.journal.report()).records.length, preview.value.report.records.length)
})

test('renderer records are reprojected, rate bounded and detached from a previous document', async t => {
  const f = await fixture(t)
  for (let n = 0; n < 10; n++) await f.invoke({ action: 'record', kind: 'pdf', diagnostic: { event: 'diagnostic', error_code: 'private-person', stack: 'private-person' } })
  const preview = await f.invoke({ action: 'preview' })
  assert.equal(preview.value.report.records.length, 8)
  assert(!JSON.stringify(preview.value.report).includes('private-person'))
  f.window.document++
  assert.equal((await f.invoke({ action: 'save', snapshotId: preview.value.snapshotId })).ok, false)
  assert.equal(f.calls(), 0)
})

test('an unavailable business worker still permits a private report with unknown queue aggregates', async t => {
  const f = await fixture(t)
  f.storage.forScope = () => ({ queueStats: async () => { throw Object.assign(Error('private database path'), { code: 'STORAGE_UNAVAILABLE' }) } })
  const preview = await f.invoke({ action: 'preview' })
  assert.equal(preview.ok, true); assert.equal(preview.value.report.state.queue, null)
  assert(!JSON.stringify(preview.value.report).includes('private database path'))
  assert.equal(preview.value.report.records.at(-1).diagnostic.error_code, 'STORAGE_UNAVAILABLE')
})
