'use strict'

const { randomUUID, createHash } = require('node:crypto')
const { bounded } = require('./protocol.cjs')

const failure = (kind, code) => ({ kind, code, message: code })
const unavailable = code => failure('unavailable', code)
const clone = value => structuredClone(value)
const canonical = value => JSON.stringify(value, (_, part) => part && typeof part === 'object' && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)
const aborted = signal => new Promise(resolve => {
  if (signal.aborted) resolve(null)
  else signal.addEventListener('abort', () => resolve(null), { once: true })
})

// This owns IPC work now; storage, session and sync adapters are installed by
// later stages. Empty capabilities must not pretend that migration is complete.
function createDesktopService({ profileId, version, electron, reads = {}, commands = {}, maxPending = 32, maxPerOwner = 8, readTimeoutMs = 10000, commandTimeoutMs = 10000 }) {
  const instanceId = randomUUID()
  let phase = 'starting', revision = 0, scope = null, epoch = 0, stopping = null
  const listeners = new Set(), pending = new Map(), receipts = new Map()
  const status = () => clone({ protocol: 1, profileId, instanceId, version, electron, phase, revision,
    context: scope ? { ...scope } : null,
    running: [...pending.values()].filter(item => item.contextId === scope?.id).length,
    capabilities: { reads: Object.keys(reads), commands: Object.keys(commands) },
  })
  const changed = () => {
    revision++
    for (const listener of listeners) { try { listener(status()) } catch { /* One leaving window cannot stop the service. */ } }
  }
  const current = contextId => phase === 'ready' && scope?.id === contextId
  const family = owner => owner.split(':')[0]
  const full = owner => pending.size >= maxPending || [...pending.values()].filter(item => family(item.owner) === family(owner)).length >= maxPerOwner
  const contextError = contextId => failure(current(contextId) ? 'unexpected' : 'unauthenticated', 'DESKTOP_CONTEXT_UNAVAILABLE')
  function setScope(value) {
    if (value != null) {
      const url = new URL(value.server)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || !Number.isSafeInteger(value.accountId) || value.accountId <= 0) throw new Error('Invalid desktop scope')
      value = { server: url.href.replace(/\/$/, ''), accountId: value.accountId }
    }
    epoch++
    scope = value ? { ...value, id: randomUUID() } : null
    for (const item of pending.values()) item.controller.abort()
    receipts.clear()
    changed()
  }
  function validResult(result, kind) {
    if (!bounded(result, 8 * 1024 * 1024) || result == null || typeof result !== 'object') return false
    const error = result.error
    const validError = error && ['unauthenticated', 'forbidden', 'not-found', 'validation', 'conflict', 'unavailable', 'storage', 'unexpected'].includes(error.kind) && typeof error.message === 'string'
    if (kind === 'read') return result.status === 'ok' ? Object.prototype.hasOwnProperty.call(result, 'data') && ['snapshot', 'refresh'].includes(result.source) : ['missing', 'cancelled'].includes(result.status) || result.status === 'failed' && validError
    return result.status === 'confirmed' ? Object.prototype.hasOwnProperty.call(result, 'data') : result.status === 'queued' || ['rejected', 'conflict', 'unknown'].includes(result.status) && validError
  }
  function finish(key) { pending.delete(key); changed() }
  function read(owner, request) {
    if (!current(request.contextId)) return Promise.resolve({ status: 'failed', error: contextError(request.contextId) })
    if (!Object.prototype.hasOwnProperty.call(reads, request.operation)) return Promise.resolve({ status: 'failed', error: unavailable('DESKTOP_ADAPTER_UNAVAILABLE') })
    const key = owner + ':' + request.requestId
    if (pending.has(key)) return Promise.resolve({ status: 'failed', error: failure('conflict', 'DESKTOP_REQUEST_ID_IN_USE') })
    if (full(owner)) return Promise.resolve({ status: 'failed', error: unavailable('DESKTOP_BUSY') })
    const controller = new AbortController(), ownEpoch = epoch
    const item = { kind: 'read', owner, contextId: request.contextId, controller }
    pending.set(key, item); changed()
    const timer = setTimeout(() => controller.abort(), readTimeoutMs)
    const scopeSnapshot = clone(scope)
    const response = Promise.resolve().then(() => reads[request.operation](clone(request.input), { source: request.source, signal: controller.signal, scope: scopeSnapshot }))
    return Promise.race([response, aborted(controller.signal)]).then(result => {
      if (controller.signal.aborted || ownEpoch !== epoch || !current(request.contextId)) return { status: 'cancelled' }
      if (!validResult(result, 'read')) return { status: 'failed', error: failure('unexpected', 'DESKTOP_INVALID_RESULT') }
      return clone(result)
    }, () => controller.signal.aborted || ownEpoch !== epoch ? { status: 'cancelled' } : { status: 'failed', error: unavailable('DESKTOP_READ_FAILED') }).finally(() => { clearTimeout(timer); finish(key) }).then(result => controller.signal.aborted || ownEpoch !== epoch ? { status: 'cancelled' } : result)
  }
  function execute(owner, request) {
    const identified = result => ({ ...result, operationId: request.operationId })
    if (!current(request.contextId)) return Promise.resolve(identified({ status: 'rejected', error: contextError(request.contextId) }))
    if (!Object.prototype.hasOwnProperty.call(commands, request.operation)) return Promise.resolve(identified({ status: 'rejected', error: unavailable('DESKTOP_ADAPTER_UNAVAILABLE') }))
    const key = request.contextId + ':' + request.operationId
    const digest = createHash('sha256').update(canonical([request.operation, request.input])).digest('hex')
    const existing = receipts.get(key)
    if (existing) return existing.digest === digest ? waitForReceipt(existing, request.operationId, request.contextId) : Promise.resolve(identified({ status: 'conflict', error: failure('conflict', 'DESKTOP_OPERATION_ID_REUSED') }))
    if (full(owner)) return Promise.resolve(identified({ status: 'rejected', error: unavailable('DESKTOP_BUSY') }))
    const controller = new AbortController(), ownEpoch = epoch, scopeSnapshot = clone(scope)
    // Commands remain owned by the service when their originating window exits.
    const pendingKey = 'command:' + key
    const item = { kind: 'command', owner, contextId: request.contextId, controller }
    pending.set(pendingKey, item); changed()
    const receipt = { digest, promise: null, finished: false }
    receipt.promise = Promise.resolve().then(() => commands[request.operation](clone(request.input), { operationId: request.operationId, signal: controller.signal, scope: scopeSnapshot })).then(result => {
      if (ownEpoch !== epoch || controller.signal.aborted) return identified({ status: 'unknown', error: unavailable('DESKTOP_CONTEXT_CHANGED') })
      if (!validResult(result, 'command')) return identified({ status: 'unknown', error: failure('unexpected', 'DESKTOP_INVALID_RESULT') })
      return identified(clone(result))
    }, () => identified({ status: 'unknown', error: unavailable('DESKTOP_COMMAND_FAILED') })).finally(() => {
      receipt.finished = true
      finish(pendingKey)
      // One-time account responses must never become an in-memory replay cache.
      if (request.operation === 'account.create') receipt.promise = Promise.resolve(identified({ status: 'unknown', error: unavailable('DESKTOP_RESULT_NOT_REPLAYABLE') }))
      while (receipts.size > 256) {
        const oldest = [...receipts.entries()].find(([, entry]) => entry.finished)
        if (!oldest) break
        receipts.delete(oldest[0])
      }
    })
    receipts.set(key, receipt)
    return waitForReceipt(receipt, request.operationId, request.contextId)
  }
  function waitForReceipt(receipt, operationId, contextId) {
    let timer
    return Promise.race([
      receipt.promise.then(clone),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unknown', operationId, error: unavailable('DESKTOP_COMMAND_PENDING') }), commandTimeoutMs) }),
    ]).finally(() => clearTimeout(timer)).then(result => scope?.id === contextId ? result : { status: 'unknown', operationId, error: unavailable('DESKTOP_CONTEXT_CHANGED') })
  }
  function detach(owner) {
    for (const item of pending.values()) if (item.owner === owner && item.kind === 'read') item.controller.abort()
  }
  function cancel(owner, requestId) {
    const item = pending.get(owner + ':' + requestId)
    if (item?.kind !== 'read') return false
    item.controller.abort(); return true
  }
  function stop(timeoutMs = 5000) {
    if (stopping) return stopping
    phase = 'stopping'; changed()
    for (const item of pending.values()) if (item.kind === 'read') item.controller.abort()
    let timer
    stopping = Promise.race([
      Promise.allSettled([...receipts.values()].filter(item => !item.finished).map(item => item.promise)).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ]).then(drained => {
      clearTimeout(timer)
      if (!drained) for (const item of pending.values()) item.controller.abort()
      phase = drained ? 'stopped' : 'failed'; changed()
      return drained
    })
    return stopping
  }
  return {
    status, setScope, read, execute, detach, cancel, stop,
    start() { if (phase !== 'starting') throw new Error('Desktop service cannot start twice'); phase = 'ready'; changed() },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

module.exports = { createDesktopService }
