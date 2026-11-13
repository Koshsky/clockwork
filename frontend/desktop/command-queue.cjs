'use strict'

const { randomUUID } = require('node:crypto')
const { createCacheApplier } = require('./command-cacheProjection.cjs')
const { validMutation, requestPath, entryOf, requestHash, unwrap, kinds } = require('./command-request.cjs')
const { decorateSnapshot, applyOwnConfirmation } = require('./command-baseline.cjs')
const { revisionsFor } = require('./command-revisions.cjs')
const { safeJSON } = require('./storage-validation.cjs')
const clone = value => structuredClone(value)
const problem = code => ({ code, message: code })
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })

function createCommandQueue({ storage, session, now = Date.now, retryMs = 60000, rateMs = 100, acknowledgementMs = 250 }) {
  let acceptingBytes = 0
  let tail = Promise.resolve(), flight = null, stopped = false, revision = 0, timer = null, running = false
  let identity = session.status().contextId
  let manualFollowUp = null
  const assertCurrent = own => { if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED') }
  const submissions = new Set()
  const listeners = new Set()
  const scope = () => { const s = session.status(); return s.server && s.user && s.mode !== 'signedOut' ? { server: s.server, accountId: s.user.id } : null }
  const current = own => !stopped && own === session.status().contextId && scope() != null
  const repo = () => { const s = scope(); if (!s) throw new Error('COMMAND_SESSION_UNAVAILABLE'); return storage.forScope(s) }
  const exclusive = run => { const result = tail.then(run); tail = result.catch(() => {}); return result }
  const status = () => ({ revision, running, contextId: session.status().contextId })
  function emit() { revision++; for (const listener of listeners) { try { listener(status()) } catch { /* A closed view cannot stop delivery. */ } } }
  const unsubscribe = session.subscribe(() => {
    if (identity !== session.status().contextId) { identity = session.status().contextId; emit() }
    if (session.status().mode === 'online') schedule(0)
  })
  async function all(repository) {
    const result = []; let after = 0
    for (;;) {
      const batch = await repository.queue({ limit: 4, after })
      result.push(...batch.filter(row => row.http && !row.http.discarded))
      if (batch.length < 4) return result
      after = batch.at(-1).sequence
    }
  }
  async function visiblePending(repository) {
    const entries = await all(repository)
    for (const entry of entries) for (const [key, token] of Object.entries(entry.input.body?._preconditions || {})) {
      const [kind, raw] = key.split(':')
      if (Number(raw) < 0) {
        const real = await repository.resolveId({ entity: 'http', temporaryId: Number(raw) })
        if (real) { delete entry.input.body._preconditions[key]; entry.input.body._preconditions[kind + ':' + real] = token }
      }
    }
    return entries
  }
  async function caches(repository) {
    const values = new Map()
    for (const key of await repository.cacheKeys()) values.set(key, await repository.cacheRead({ key }))
    return values
  }
  async function overlay(values, entries, mappings, repository) {
    const projected = new Map([...values].map(([key, value]) => [key, clone(value.baseline)]))
    const applier = createCacheApplier({ keys: async () => [...projected.keys()], get: async key => projected.get(key), put: async (key, value) => { projected.set(key, value) } })
    for (const row of entries) {
      if (row.status && !['queued', 'unknown'].includes(row.status)) continue
      const input = clone(row.input), ids = new Map(mappings.map(mapping => [mapping.temporaryId, mapping.realId]))
      for (const id of referencedIds(input)) if (!ids.has(id)) {
        const real = await repository.resolveId({ entity: 'http', temporaryId: id })
        if (real) ids.set(id, real)
      }
      rewrite(input, ids)
      await applier.applyToCache(entryOf(input, row.operationId, row.http?.createdAt || now()))
    }
    return [...values].flatMap(([key, value]) => JSON.stringify(projected.get(key)) === JSON.stringify(value.projection) ? [] : [{ key, expectedRevision: value.revision, baseline: value.baseline, revisions: value.revisions, projection: projected.get(key) }])
  }
  function rewrite(value, ids) {
    if (!value || typeof value !== 'object') return value
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tempId') continue
      if (['path', 'query'].includes(key)) { for (const [name, id] of Object.entries(child || {})) if (ids.has(Number(id))) child[name] = String(ids.get(Number(id))); continue }
      if (key === 'ids' && Array.isArray(child)) value[key] = child.map(id => ids.get(id) ?? id)
      else if ((key === 'id' || key.endsWith('_id')) && typeof child === 'number' && ids.has(child)) value[key] = ids.get(child)
      else if (child && typeof child === 'object') rewrite(child, ids)
    }
    return value
  }
  function referencedIds(input) {
    const found = new Set()
    const visit = (value, name = '') => {
      if (typeof value === 'number' && value < 0 && (name.endsWith('_id') || name === 'id' || name === 'ids')) found.add(value)
      else if (Array.isArray(value)) value.forEach(part => visit(part, name))
      else if (value && typeof value === 'object') for (const [key, part] of Object.entries(value)) {
        if (key === 'tempId') continue
        if (key === 'path') for (const id of Object.values(part || {})) { if (Number(id) < 0) found.add(Number(id)) }
        else visit(part, key)
      }
    }
    visit(input); return found
  }
  async function submit(request) {
    const bytes = Buffer.byteLength(JSON.stringify(request.input))
    if (acceptingBytes + bytes > 16 * 1024 * 1024) throw new Error('COMMAND_BUSY')
    acceptingBytes += bytes
    try { return await submitOwned(request) } finally { acceptingBytes -= bytes }
  }
  async function submitOwned(request) {
    const own = identity
    if (!validMutation(request.input)) throw new Error('COMMAND_INVALID_REQUEST')
    safeJSON(request.input)
    await exclusive(async () => {
      if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
      const repository = repo(), existing = await repository.receipt({ operationId: request.operationId })
      if (existing) {
        // Storage validates the complete immutable intent even after confirmation.
        const known = await repository.httpIntent({ operationId: request.operationId })
        const replay = clone(request.input); replay.body = { ...(replay.body || {}), _preconditions: known?.body?._preconditions || {} }
        await repository.commitHttp({ operationId: request.operationId, input: replay })
        return
      }
      const entries = await all(repository), values = await caches(repository), negatives = referencedIds(request.input)
      const canonicalInput = clone(request.input)
      for (const id of referencedIds(canonicalInput)) {
        const real = await repository.resolveId({ entity: 'http', temporaryId: id })
        if (real) rewrite(canonicalInput, new Map([[id, real]]))
      }
      const family = canonicalInput.route.split(' ')[1].split('/')[1]
      const history = canonicalInput.path?.id ? await repository.httpHistory({ path: canonicalInput.route.split(' ')[1], id: Number(canonicalInput.path.id), createRoute: 'POST /' + family }) : []
      const baseline = request.input.preconditions == null ? revisionsFor(canonicalInput, values) : clone(request.input.preconditions), causal = [], observed = []
      for (const [key, token] of Object.entries(baseline)) {
        const id = Number(key.split(':')[1])
        if (id < 0) {
          const real = await repository.resolveId({ entity: 'http', temporaryId: id })
          if (real) { const name = key.slice(0, key.lastIndexOf(':') + 1) + real; if (baseline[name] && baseline[name] !== token) throw new Error('COMMAND_BASELINE_AMBIGUOUS'); delete baseline[key]; baseline[name] = token }
        }
      }
      for (const [key, token] of Object.entries(baseline)) if (token.startsWith('local:')) {
        const operationId = token.slice(6), pending = entries.find(row => row.operationId === operationId)
        const receipt = await repository.receipt({ operationId })
        if (!pending && receipt?.status !== 'confirmed') throw new Error('COMMAND_BASELINE_REQUIRED')
        let source = pending?.input.body?._preconditions?.[key] ?? receipt?.result?.revisions?.[key]
        if (source == null && pending) for (const [name, value] of Object.entries(pending.input.body?._preconditions || {})) {
          const [kind, raw] = name.split(':')
          if (Number(raw) < 0 && kind === key.split(':')[0]) {
            const real = await repository.resolveId({ entity: 'http', temporaryId: Number(raw) })
            if (key === kind + ':' + real) source = value
          }
        }
        if (typeof source === 'string') baseline[key] = source
        else if (pending?.http.tempId != null && key.endsWith(':' + pending.http.tempId)) baseline[key] = 'pending'
        else throw new Error('COMMAND_BASELINE_REQUIRED')
        observed.push(operationId)
      }
      for (const receipt of request.input.preconditions == null ? history : []) {
        let used = false
        for (const [key, token] of Object.entries(receipt.result.revisions || {})) {
          if (Object.hasOwn(baseline, key) && baseline[key] === receipt.result.previousRevisions?.[key]) { baseline[key] = token; used = true }
        }
        if (used) causal.push(receipt.operationId)
      }
      const preceding = new Map()
      if (request.input.preconditions == null) for (const row of entries) for (const key of Object.keys(row.input.body?._preconditions || {})) if (Object.hasOwn(baseline, key)) preceding.set(key, row.operationId)
      const dependencies = [...new Set([...entries.filter(row => negatives.has(row.http.tempId)).map(row => row.operationId), ...preceding.values(), ...causal, ...observed])]
      for (const id of negatives) {
        const mapped = await repository.resolveId({ entity: 'http', temporaryId: id })
        if (!mapped && !entries.some(row => row.http.tempId === id)) throw new Error('COMMAND_MISSING_CREATOR')
      }
      const input = clone(request.input)
      input.body = { ...(input.body || {}), _preconditions: baseline }
      const entry = { operationId: request.operationId, input, http: { createdAt: now() } }
      const changes = await overlay(values, [...entries, entry], [], repository)
      assertCurrent(own)
      await repository.commitHttp({ operationId: request.operationId, input, dependencies, changes })
      if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
      emit()
    })
    assertCurrent(own)
    const work = push(false, request.operationId)
    await Promise.race([work, delay(acknowledgementMs)])
    if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
    const receipt = await repo().receipt({ operationId: request.operationId })
    return receipt?.status === 'confirmed' || ['rejected', 'conflict'].includes(receipt?.status) ? receipt.result : { status: 202, data: { data: null, error: {} }, queued: true, operationId: request.operationId }
  }
  async function send(repository, entry, own, capability) {
    let wire = entry.http.wire
    if (!wire) {
      const input = clone(entry.input), ids = new Map()
      for (const id of referencedIds(input)) {
        const real = await repository.resolveId({ entity: 'http', temporaryId: id })
        if (!real) return false
        ids.set(id, real)
      }
      rewrite(input, ids)
      for (const [temporaryId, realId] of ids) {
        for (const [key, token] of Object.entries(input.body?._preconditions || {})) {
          if (key.endsWith(':' + temporaryId)) { delete input.body._preconditions[key]; input.body._preconditions[key.slice(0, key.lastIndexOf(':') + 1) + realId] = token }
        }
      }
      const observed = clone(entry.input.preconditions || {})
      for (const [key, token] of Object.entries(observed)) {
        const [kind, raw] = key.split(':')
        if (Number(raw) < 0) {
          const real = await repository.resolveId({ entity: 'http', temporaryId: Number(raw) })
          if (real) { delete observed[key]; observed[kind + ':' + real] = token }
        }
      }
      const acknowledgements = await Promise.all(entry.dependencies.map(operationId => repository.receipt({ operationId })))
      for (const receipt of acknowledgements.sort((left, right) => (left?.result?.sequence || 0) - (right?.result?.sequence || 0))) {
        const next = receipt?.result?.revisions || {}
        for (const [key, token] of Object.entries(next)) if (Object.hasOwn(input.body?._preconditions || {}, key) && (entry.input.preconditions == null || observed[key] === 'local:' + receipt.operationId || observed[key] === 'pending')) input.body._preconditions[key] = token
      }
      if (Object.values(input.body?._preconditions || {}).includes('pending')) throw new Error('COMMAND_BASELINE_REQUIRED')
      wire = { route: input.route, path: input.path || {}, query: input.query || {}, body: input.body, locale: input.locale || 'ru' }
      if (capability.revision_protocol !== 1 || !capability.operations.includes(input.route)) throw new Error('COMMAND_DURABLE_UNSUPPORTED')
      await repository.freezeHttp({ operationId: entry.operationId, wire })
    }
    const native = async request => {
      if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
      return session.api('command-queue', { contextId: own, requestId: randomUUID(), ...request }, { bypassQueue: true, revisionProtocol: true })
    }
    let response
    if (entry.attempts > 0) {
      const check = await native({ operation: 'GET /operations/{operation_id}', path: { operation_id: entry.operationId } })
      if (check.status !== 200 || !check.data?.data) throw new Error('COMMAND_STATUS_UNAVAILABLE')
      const receipt = check.data.data
      if (receipt.state === 'in_progress') return false
      if (receipt.state === 'confirmed') {
        const method = wire.route.split(' ')[0], path = requestPath({ route: wire.route, path: wire.path, query: wire.query, body: wire.body })
        if (receipt.method !== method || receipt.path !== path || receipt.request_hash !== requestHash(wire.body) || receipt.response_status < 200 || receipt.response_status >= 300) throw new Error('COMMAND_RECEIPT_MISMATCH')
        response = { status: receipt.response_status, data: receipt.response }
      } else if (receipt.state !== 'not_found') throw new Error('COMMAND_STATUS_UNAVAILABLE')
    }
    if (!response) {
      await repository.markAttempt({ operationId: entry.operationId })
      if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
      response = await native({ operation: wire.route, path: wire.path, query: wire.query, body: wire.body, locale: wire.locale, operationId: entry.operationId, key: entry.operationId })
    }
    if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
    if (response.status === 401) return false
    if (response.status === 429 || response.status >= 500 || response.operationStatus === 'in_progress') {
      await repository.deferHttp({ operationId: entry.operationId, retryAt: now() + Math.max(retryMs, Math.min(3600000, (response.retryAfter || 0) * 1000)), error: problem(response.status === 429 ? 'COMMAND_RATE_LIMIT' : 'COMMAND_RETRY_PENDING') })
      return false
    }
    const accepted = response.status >= 200 && response.status < 300
    if (accepted && (response.data?.error?.code != null || response.data?.error?.message || !response.data?.data || !Object.hasOwn(response.data.data, 'snapshot') || !response.data.data._revisions)) throw new Error('COMMAND_INVALID_RECEIPT')
    const status = accepted ? 'confirmed' : response.status === 409 ? 'conflict' : 'rejected'
    const mappings = [], unwrapped = unwrap(response)
    if (accepted && entry.http.tempId != null) {
      const realId = unwrapped.result.data?.data?.id
      if (!Number.isSafeInteger(realId) || realId <= 0) throw new Error('COMMAND_INVALID_CREATE_RECEIPT')
      mappings.push({ entity: 'http', temporaryId: entry.http.tempId, realId })
    }
    await exclusive(async () => {
      if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
      const values = await caches(repository), entries = await all(repository)
      assertCurrent(own)
      const dto = unwrapped.result.data?.data
      if (accepted) {
        // A receipt's DTO replaces the temporary projection without refreshing its baseline from the network.
        const confirmed = clone(entry.input); confirmed.body = { ...confirmed.body, ...(unwrapped.result.data?.data || {}) }
        if (mappings.length) confirmed.tempId = mappings[0].realId
        const guardedKeys = Object.keys(wire.body?._preconditions || {})
        if (!guardedKeys.length && dto?.id) { const kind = entry.input.route.split(' ')[1].split('/')[1]; guardedKeys.push((kind === 'resources' ? 'resource' : kind) + ':' + dto.id) }
        // Private watermarks distinguish an older own projection from a newer GET without lending versions to stale rows.
        const knownKeys = new WeakMap()
        const mayConfirm = value => {
          const tokens = new Map(Object.entries(value.revisions || {}).map(([name, token]) => [name, new Set([token])]))
          const visit = node => {
            if (!node || typeof node !== 'object') return
            for (const [name, token] of Object.entries(node._baseline || {})) { if (!tokens.has(name)) tokens.set(name, new Set()); tokens.get(name).add(token) }
            for (const [name, child] of Object.entries(node)) if (name !== '_baseline' && name !== '_pending' && name !== '_confirmed') visit(child)
          }
          visit(value.baseline)
          knownKeys.set(value, new Set(tokens.keys()))
          for (const name of guardedKeys) {
            const compared = value.baseline._confirmed?.[name] ? [value.baseline._confirmed[name]] : tokens.get(name) || []
            if ([...compared].some(token => token !== wire.body?._preconditions?.[name] && token !== unwrapped.revisions[name])) return false
          }
          return true
        }
        const baselines = new Map([...values].filter(([, value]) => mayConfirm(value)).map(([key, value]) => [key, { ...value, projection: clone(value.baseline) }]))
        const updates = await overlay(baselines, [{ operationId: entry.operationId, input: confirmed, http: entry.http }], [], repository)
        for (const change of updates) { const value = values.get(change.key); value.baseline = change.projection }
        const changedKeys = new Set(updates.map(change => change.key))
        for (const key of baselines.keys()) {
          const value = values.get(key)
          for (const [name, token] of Object.entries(unwrapped.revisions)) if (changedKeys.has(key) || knownKeys.get(value)?.has(name)) { value.baseline._confirmed ||= {}; value.baseline._confirmed[name] = token }
          applyOwnConfirmation(value.baseline?.data?.data, unwrapped.revisions, entry.input.route, dto, key)
          if (entry.input.route.includes('/user/{id}/days')) {
            const path = new URL(key, 'https://cache.invalid').pathname, id = Number(entry.input.path.id)
            if (path.endsWith('/user/' + id + '/days') || path.endsWith('/user/days')) {
              for (const name of ['user_days:' + id, 'states']) if (value.revisions[name] === wire.body._preconditions[name] && unwrapped.revisions[name]) value.revisions[name] = unwrapped.revisions[name]
            }
          }
        }
      }
      const cacheChanges = await overlay(values, entries.filter(row => row.operationId !== entry.operationId), mappings, repository)
      // Persist changed baselines even when their resulting projection happens to be identical.
      for (const [key, value] of values) if (!cacheChanges.some(change => change.key === key)) {
        const original = await repository.cacheRead({ key })
        if (JSON.stringify(original.baseline) !== JSON.stringify(value.baseline) || JSON.stringify(original.revisions) !== JSON.stringify(value.revisions)) cacheChanges.push({ key, expectedRevision: value.revision, baseline: value.baseline, projection: value.baseline, revisions: value.revisions })
      }
      assertCurrent(own)
      await repository.settle({ operationId: entry.operationId, status, result: { ...unwrapped.result, operationId: entry.operationId, data: accepted ? { ...unwrapped.result.data, data: decorateSnapshot(dto, unwrapped.revisions, entry.input.route) } : unwrapped.result.data, baseline: unwrapped.revisions, revisions: unwrapped.revisions, previousRevisions: wire.body?._preconditions || {}, sequence: entry.sequence }, mappings, cacheChanges })
      emit()
    })
    return true
  }
  async function drain(force = false, requested = new Set()) {
    const own = identity
    if (!current(own) || session.status().needsLogin) return
    const automatic = (await exclusive(() => repo().setting({ key: 'queue.auto-sync' })))?.value !== false
    if (!force && !automatic && requested.size === 0) return
    running = true; emit()
    try {
      if (session.status().mode !== 'online') { await session.refresh(); if (session.status().mode !== 'online' || !current(own)) return }
      const capability = await session.api('command-queue', { contextId: own, requestId: randomUUID(), operation: 'GET /operations' }, { bypassQueue: true })
      if (capability.status !== 200 || capability.data?.data?.protocol !== 1 || capability.data.data.durable !== true || !Array.isArray(capability.data.data.operations)) throw new Error('COMMAND_DURABLE_UNSUPPORTED')
      const repository = repo(), entries = await all(repository), selected = new Set(requested)
      if (!force) {
        let expanded = true
        while (expanded) {
          expanded = false
          for (const row of entries) if (selected.has(row.operationId)) for (const id of row.dependencies) if (!selected.has(id)) { selected.add(id); expanded = true }
        }
      }
      for (const saved of entries) {
        if (!current(own) || session.status().needsLogin) break
        const automaticNow = (await exclusive(() => repository.setting({ key: 'queue.auto-sync' })))?.value !== false
        if (!current(own)) break
        if (!force && !automaticNow && !selected.has(saved.operationId)) continue
        // Re-read dependencies after each acknowledgement in the same batch.
        const entry = (await all(repository)).find(row => row.operationId === saved.operationId)
        if (!entry || !entry.ready || !['queued', 'unknown'].includes(entry.status) || entry.http.retryAt > now() && (!force || entry.http.error?.code === 'COMMAND_RATE_LIMIT')) continue
        try {
          if (!await send(repository, entry, own, capability.data.data)) break
        } catch (error) {
          if (current(own)) await repository.deferHttp({ operationId: entry.operationId, retryAt: now() + retryMs, error: problem(error.message?.startsWith('COMMAND_') ? error.message : 'COMMAND_RESPONSE_UNKNOWN') })
          break
        }
        if (rateMs) await delay(rateMs)
      }
    } finally { running = false; emit() }
  }
  function schedule(ms = retryMs) {
    if (timer && ms === 0) { clearTimeout(timer); timer = null }
    if (stopped || timer) return
    timer = setTimeout(() => { timer = null; void push() }, ms); timer.unref?.()
  }
  function push(force = false, operationId = null) {
    if (operationId) submissions.add(operationId)
    if (stopped) return Promise.resolve()
    if (flight) {
      if (!force) return flight
      if (!manualFollowUp) manualFollowUp = flight.then(() => { manualFollowUp = null; return push(true) })
      return manualFollowUp
    }
    const requested = new Set(submissions); submissions.clear()
    flight = drain(force, requested).catch(() => {}).finally(() => { flight = null; if (submissions.size && !stopped) void push(); else schedule() })
    return flight
  }
  async function readCache(key, own = identity) {
    return exclusive(async () => {
      assertCurrent(own)
      const repository = repo(), value = await repository.cacheRead({ key }), pending = await visiblePending(repository)
      assertCurrent(own)
      return value ? { ...value, pending } : value
    })
  }
  function exposed(row, key) {
    if (!row) return undefined
    const local = key.startsWith('/local/resource-header?'), baseline = clone(row.revisions)
    const data = decorateSnapshot(local ? row.projection.data : row.projection.data?.data, row.revisions, key)
    const clearPending = node => { if (!node || typeof node !== 'object') return; delete node._pending; for (const child of Object.values(node)) clearPending(child) }
    clearPending(data)
    for (const entry of row.pending || []) {
      if (!['queued', 'unknown'].includes(entry.status)) continue
      const names = Object.keys(entry.input.body?._preconditions || {}).filter(name => name !== 'states' || !entry.input.route.includes('/user/{id}/days'))
      if (entry.http.tempId != null && /^POST \/(?:project|process|resources)$/.test(entry.input.route)) names.push((entry.input.route === 'POST /resources' ? 'resource' : entry.input.route.split('/')[1]) + ':' + entry.http.tempId)
      for (const name of names) if (Object.hasOwn(baseline, name)) baseline[name] = 'local:' + entry.operationId
      const visit = node => {
        if (!node || typeof node !== 'object') return
        if (node._baseline) for (const name of names) if (Object.hasOwn(node._baseline, name)) { node._pending ||= {}; node._pending[name] = entry.operationId }
        for (const [name, child] of Object.entries(node)) if (name !== '_baseline' && name !== '_pending') visit(child)
      }
      visit(data)
    }
    const projection = { ...row.projection }; delete projection._confirmed
    return { ...projection, baseline, data: local ? data : { ...row.projection.data, data } }
  }
  async function cacheGet(key, own = identity) { return (await readCache(key, own))?.projection }
  async function cachePut(key, value, revisions = {}, stamp = revision, own = identity) {
    return exclusive(async () => {
      assertCurrent(own)
      const repository = repo(), previous = await repository.cacheRead({ key })
      assertCurrent(own)
      const entries = await all(repository)
      assertCurrent(own)
      if (stamp !== revision) { if (!previous) throw new Error('COMMAND_SNAPSHOT_CHANGED'); return { ...previous, pending: await visiblePending(repository) } }
      const values = new Map([[key, { key, revision: previous?.revision ?? 0, baseline: value, projection: value, revisions }]])
      const changes = await overlay(values, entries, [], repository)
      assertCurrent(own)
      if (!changes.length) changes.push({ key, expectedRevision: previous?.revision ?? 0, baseline: value, projection: value, revisions })
      await repository.cacheCommit({ changes })
      assertCurrent(own)
      return { projection: changes[0].projection, revisions, pending: await visiblePending(repository) }
    })
  }
  async function control(request) {
    const own = identity
    assertCurrent(own)
    const value = await controlOwned(request, own)
    assertCurrent(own)
    return value
  }
  async function controlOwned(request, own) {
    if (!scope() || stopped) throw new Error('COMMAND_SESSION_UNAVAILABLE')
    if (request.action === 'enqueue') { if (request.input?.preconditions == null) throw new Error('COMMAND_BASELINE_REQUIRED'); return submit(request) }
    if (request.action === 'cachePut') {
      if (typeof request.key !== 'string') throw new Error('COMMAND_INVALID_REQUEST')
      if (!request.key.startsWith('/local/resource-header?owner_id=') || !request.value || !Number.isSafeInteger(request.value.ts) || !Array.isArray(request.value.data)) throw new Error('COMMAND_INVALID_REQUEST')
      await cachePut(request.key, request.value); return null
    }
    if (request.action === 'push') { await push(true); return null }
    return exclusive(async () => {
      assertCurrent(own)
      const repository = repo()
      if (request.action === 'list') {
        const batch = request.after == null ? null : await repository.queue({ limit: 4, after: request.after })
        const entries = batch ? batch.filter(row => row.http && !row.http.discarded) : await all(repository)
        for (const entry of entries) {
          const ids = new Map()
          for (const id of referencedIds(entry.input)) { const real = await repository.resolveId({ entity: 'http', temporaryId: id }); if (real) ids.set(id, real) }
          rewrite(entry.input, ids)
        }
        return batch ? { items: entries, after: batch.at(-1)?.sequence ?? request.after, complete: batch.length < 4 } : entries
      }
      if (request.action === 'configure') {
        if (typeof request.autoSync !== 'boolean') throw new Error('COMMAND_INVALID_REQUEST')
        const previous = await repository.setting({ key: 'queue.auto-sync' })
        await repository.saveSetting({ key: 'queue.auto-sync', value: request.autoSync, expectedRevision: previous?.revision ?? 0 })
        if (request.autoSync) schedule(0)
        return null
      }
      if (request.action === 'cacheKeys') return repository.cacheKeys()
      if (request.action === 'cacheGet') { const row = await repository.cacheRead({ key: request.key }); return row ? exposed({ ...row, pending: await visiblePending(repository) }, request.key) : undefined }
      if (request.action === 'retry') { await repository.retryHttp({ operationId: request.operationId }); emit(); schedule(0); return null }
      if (request.action === 'discard') {
        const entries = await all(repository), values = await caches(repository)
        const changes = await overlay(values, entries.filter(row => !request.operationIds.includes(row.operationId)), [], repository)
        await repository.discardHttp({ operationIds: request.operationIds, changes }); emit(); return null
      }
      throw new Error('COMMAND_INVALID_REQUEST')
    })
  }
  return {
    status, submit, push, control, cacheGet, cachePut,
    async cacheKeys() { return scope() ? repo().cacheKeys() : [] },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async api(request, sendRequest) {
      if (kinds.has(request.operation)) {
        if (request.viewUser) throw new Error('COMMAND_VIEW_ONLY')
        if (request.preconditions == null) throw new Error('COMMAND_BASELINE_REQUIRED')
        return submit({ operationId: request.key || randomUUID(), input: { route: request.operation, path: request.path || {}, query: request.query || {}, body: request.body, tempId: request.tempId, locale: request.locale, ...(request.preconditions == null ? {} : { preconditions: request.preconditions }) } })
      }
      if (!request.operation.startsWith('GET ') || request.operation.startsWith('GET /operations') || request.viewUser) return sendRequest()
      const root = session.status().server, route = require('./api-routes.json').find(row => row.operation === request.operation)
      let path = route.path; for (const [name, id] of Object.entries(request.path || {})) path = path.replace('{' + name + '}', encodeURIComponent(String(id)))
      const query = new URLSearchParams(request.query || {}), key = root + path + (query.size ? '?' + query : ''), own = identity, stamp = revision
      try {
        const wrapped = await sendRequest({ revisionProtocol: true }), value = unwrap(wrapped)
        assertCurrent(own)
        if (current(own) && wrapped.status >= 200 && wrapped.status < 300) {
          const cached = await cachePut(key, { ts: now(), data: value.result.data }, value.revisions, stamp, own)
          assertCurrent(own)
          return cached ? { ...value.result, data: exposed(cached, key).data, baseline: exposed(cached, key).baseline } : value.result
        }
        return value.result
      } catch (error) {
        if (!current(own)) throw error
        const cached = await readCache(key, own)
        assertCurrent(own)
        if (cached) return { status: 200, data: exposed(cached, key).data, baseline: exposed(cached, key).baseline, localSnapshot: true }
        throw error
      }
    },
    async stop() { stopped = true; clearTimeout(timer); unsubscribe(); await flight; await tail; listeners.clear() },
  }
}
module.exports = { createCommandQueue }
