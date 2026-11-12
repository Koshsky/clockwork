'use strict'

const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { bounded } = require('./protocol.cjs')
const { StorageError, scopeOf, requireValue } = require('./storage-validation.cjs')
const readMethods = new Set(['snapshot', 'queue', 'receipt', 'resolveId', 'setting', 'info'])

async function createStorage({ directory, readOnly = false, timeoutMs = 15000, startupTimeoutMs = 10000 }) {
  // Node's worker loader must receive a real file, including inside packaged ASAR apps.
  const workerFile = path.join(__dirname, 'storage-worker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  const worker = new Worker(workerFile, { workerData: { directory, readOnly }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } })
  const listeners = new Set(), pending = new Map()
  let phase = 'starting', info = {}, code = null, sequence = 0, pendingBytes = 0, closing = null
  const status = () => ({ phase, ...info, ...(code ? { code } : {}) })
  const emit = () => { for (const listener of listeners) { try { listener(status()) } catch { /* Views cannot block durability acknowledgements. */ } } }
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const startupTimer = setTimeout(() => fail('STORAGE_START_TIMEOUT'), startupTimeoutMs)
  function fail(reason) {
    if (phase === 'stopped' || phase === 'failed') return
    phase = 'failed'; code = reason
    clearTimeout(startupTimer); readyReject(new StorageError(reason))
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new StorageError(item.write ? 'STORAGE_OUTCOME_UNKNOWN' : reason))
    }
    pending.clear(); pendingBytes = 0; emit()
    void worker.terminate()
  }
  worker.on('message', message => {
    if (message?.kind === 'ready') {
      if (phase !== 'starting') return
      clearTimeout(startupTimer); info = message.info; phase = 'ready'; emit(); readyResolve()
    } else if (message?.kind === 'failed') fail(message.code || 'STORAGE_UNAVAILABLE')
    else if (message?.kind === 'result') {
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id); pendingBytes -= item.bytes; clearTimeout(item.timer)
      if (message.ok) item.resolve(message.value)
      else item.reject(new StorageError(message.code || 'STORAGE_UNAVAILABLE'))
    }
  })
  worker.on('error', () => fail('STORAGE_WORKER_FAILED'))
  worker.on('exit', () => { if (phase !== 'stopped') fail('STORAGE_WORKER_EXITED') })
  await ready
  function request(method, scope, params, stopping = false) {
    if (phase !== 'ready' && !(stopping && phase === 'closing')) return Promise.reject(new StorageError('STORAGE_UNAVAILABLE'))
    const message = { id: ++sequence, method, scope, params }
    if (!bounded(message, 16 * 1024 * 1024)) return Promise.reject(new StorageError('STORAGE_INVALID_INPUT'))
    const bytes = Buffer.byteLength(JSON.stringify(message))
    if (!stopping && (pending.size >= 64 || pendingBytes + bytes > 32 * 1024 * 1024)) return Promise.reject(new StorageError('STORAGE_BUSY'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('STORAGE_REQUEST_TIMEOUT'), timeoutMs)
      pending.set(message.id, { resolve, reject, timer, bytes, write: !readMethods.has(method) }); pendingBytes += bytes
      try { worker.postMessage(message) } catch { fail('STORAGE_WORKER_FAILED') }
    })
  }
  return {
    status,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    forScope(scope) {
      const selected = scopeOf(scope)
      return Object.freeze(Object.fromEntries(['snapshot', 'saveSnapshot', 'commitLocal', 'queue', 'receipt', 'markAttempt', 'settle', 'resolveId', 'setting', 'saveSetting'].map(method => [method, params => request(method, selected, params)])))
    },
    backup: () => request('backup'),
    abort() { fail('STORAGE_ABORTED'); return worker.terminate() },
    close() {
      if (closing) return closing
      if (phase === 'failed') return worker.terminate().then(() => false)
      phase = 'closing'; emit()
      closing = request('close', undefined, undefined, true).then(async () => { phase = 'stopped'; emit(); await worker.terminate(); return true }, async () => { await worker.terminate(); return false })
      return closing
    },
  }
}
module.exports = { createStorage }
