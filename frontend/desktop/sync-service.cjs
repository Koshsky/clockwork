'use strict'

const { randomUUID } = require('node:crypto')
const routes = require('./api-routes.json').filter(route => route.method === 'GET' && !route.path.startsWith('/operations') && route.path !== '/health')
const { decorateSnapshot } = require('./command-baseline.cjs')
const { unwrap } = require('./command-request.cjs')
const domains = ['permissions', 'profile', 'projects', 'users', 'resources', 'members', 'assignments', 'myStaff', 'project-plan', 'process-plan', 'task-plan', 'states', 'employees', 'periods', 'calendar']
const defaults = [
  ['projects', 'GET /project', { limit: '500', offset: '0' }], ['users', 'GET /user/all'],
  ['assignments', 'GET /assignment', { limit: '500', offset: '0' }], ['myStaff', 'GET /user', { limit: '500', offset: '0' }],
  ['project-plan', 'GET /planning/projects'], ['process-plan', 'GET /planning/processes'], ['task-plan', 'GET /planning/tasks'],
  ['states', 'GET /timesheet/states'], ['employees', 'GET /user', { limit: '50', offset: '0' }], ['calendar', 'GET /timesheet/calendar'],
]
function requestKey(server, request) {
  const route = routes.find(row => row.operation === request.operation)
  if (!route) throw new Error('SYNC_INVALID_REQUEST')
  let path = route.path
  for (const [name, id] of Object.entries(request.path || {})) path = path.replace('{' + name + '}', encodeURIComponent(String(id)))
  const query = new URLSearchParams(request.query || {})
  return server + path + (query.size ? '?' + query : '')
}
function requestFor(server, key) {
  if (!key.startsWith(server + '/')) return null
  const url = new URL(key), root = new URL(server), path = url.pathname.slice(root.pathname.length)
  for (const route of routes) {
    const names = [...route.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1])
    const match = new RegExp('^' + route.path.replace(/\{[^}]+\}/g, '([1-9]\\d*)') + '$').exec(path)
    if (!match || [...url.searchParams.keys()].some(name => !route.query.includes(name))) continue
    return { operation: route.operation, path: Object.fromEntries(names.map((name, i) => [name, match[i + 1]])), query: Object.fromEntries(url.searchParams) }
  }
  return null
}

// The owner outlives every renderer; network waits never hold the queue's commit lock.
function createSyncService({ storage, session, queue, powerMonitor, now = Date.now, intervalMs = 60000, probeMs = 10000, debounceMs = 400, rateMs = 100, timers = globalThis }) {
  const { setTimeout, clearTimeout, setInterval, clearInterval } = timers
  let stopped = false, suspended = false, flight = null, followUp = null, timer = null, refreshTimer = null
  let flightForce = false, flightPullOnly = false, again = false, generation = 0, configuration = Promise.resolve()
  let revision = 0, reachable = null, running = false, lastPullAt = null, nextPullAt = 0, nextProbeAt = 0, progress = null, code = null
  let context = session.status().contextId, observedMutation = queue.status().mutationRevision
  let lastRequestAt = -Infinity
  const pauses = new Set()
  const observed = new Map()
  const listeners = new Set(), settingsKey = 'sync.options', timestampKey = 'sync.last-pull'
  const status = () => ({ revision, contextId: session.status().contextId, running, reachable, lastPullAt, progress, reconnectAt: reachable === false ? nextProbeAt : null, ...(code ? { code } : {}) })
  const emit = () => { revision++; for (const listener of listeners) { try { listener(status()) } catch { /* Leaving windows do not own synchronization. */ } } }
  const identity = () => { const s = session.status(); return s.user && s.mode !== 'signedOut' ? { server: s.server, accountId: s.user.id } : null }
  const current = own => !stopped && !suspended && own === session.status().contextId && identity() != null
  const repository = () => storage.forScope(identity())
  async function options() { return (await repository().setting({ key: settingsKey }))?.value || {} }
  async function raw(request, own) {
    if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
    const epoch = generation, delay = Math.max(0, lastRequestAt + rateMs - now())
    if (delay) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); pauses.delete(finish); resolve() }
      const timer = setTimeout(finish, delay); timer.unref?.(); pauses.add(finish)
    })
    if (!current(own) || epoch !== generation) throw new Error('SESSION_CONTEXT_CHANGED')
    lastRequestAt = now()
    const response = await session.api('desktop-sync', { ...request, contextId: own, requestId: randomUUID() }, { bypassQueue: true, revisionProtocol: true })
    if (!current(own) || epoch !== generation) throw new Error('SESSION_CONTEXT_CHANGED')
    if (response.status === 401) throw new Error('SYNC_LOGIN_REQUIRED')
    if (response.status >= 500 || response.status === 429) throw new Error('SYNC_SERVER_UNAVAILABLE')
    return response
  }
  async function read(request, own) {
    const stamp = queue.status().revision
    const response = await raw(request, own), value = unwrap(response), denied = [403, 404].includes(response.status)
    if (!denied && (response.status < 200 || response.status >= 300 || !value.result.data || value.result.data.error?.message)) throw new Error('SYNC_INVALID_RESPONSE')
    return { stamp, key: requestKey(session.status().server, request), value: { ts: now(), ...(denied ? { status: response.status } : {}), data: denied ? { data: null, error: value.result.data?.error || {} } : value.result.data }, revisions: denied ? {} : value.revisions }
  }
  async function completeResources(own, stamp) {
    const server = session.status().server, pages = [], rows = [], revisions = {}, ids = new Set()
    let total = null
    for (let offset = 0; ; offset += 500) {
      if (offset >= 50000) throw new Error('SYNC_RESOURCE_LIMIT')
      const page = await read({ operation: 'GET /resources', query: { limit: '500', offset: String(offset) } }, own)
      pages.push(page)
      if (page.value.status) { rows.length = 0; break }
      const data = page.value.data.data
      if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0 || data.items.length > 500 || total != null && total !== data.total) throw new Error('SYNC_RESOURCE_SNAPSHOT_CHANGED')
      total = data.total
      Object.assign(revisions, page.revisions)
      for (const row of data.items) {
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)) throw new Error('SYNC_RESOURCE_SNAPSHOT_CHANGED')
        ids.add(row.id); rows.push(row)
      }
      if (rows.length === total) break
      if (!data.items.length || rows.length > total) throw new Error('SYNC_RESOURCE_SNAPSHOT_CHANGED')
    }
    const keys = await queue.cacheKeys(), ownId = session.status().user.id
    const owners = new Set(['all', String(ownId)])
    for (const key of keys) if (/^\/local\/resource-header\?owner_id=(all|[1-9]\d*)$/.test(key)) owners.add(key.split('=').at(-1))
    for (const owner of owners) {
      const denied = pages[0].value.status
      pages.push({ key: '/local/resource-header?owner_id=' + owner, value: { ts: now(), ...(denied ? { status: denied } : {}), data: decorateSnapshot(owner === 'all' ? rows : rows.filter(row => row.owner_id === Number(owner)), revisions, '/resources') }, revisions: {} })
    }
    // The complete roster is authoritative; table pages retain their requested sizes.
    for (const key of keys) {
      const request = requestFor(server, key)
      if (request?.operation !== 'GET /resources' || pages.some(page => page.key === key)) continue
      const offset = Number(request.query.offset || 0), limit = Number(request.query.limit || 50), owner = request.query.owner_id
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) continue
      const filtered = owner ? rows.filter(row => row.owner_id === Number(owner)) : rows
      const items = filtered.slice(offset, offset + limit)
      const pageRevisions = Object.fromEntries(items.flatMap(row => revisions['resource:' + row.id] ? [['resource:' + row.id, revisions['resource:' + row.id]]] : []))
      pages.push({ key, value: { ts: now(), ...(pages[0].value.status ? { status: pages[0].value.status } : {}), data: { data: { items, total: filtered.length }, error: {} } }, revisions: pageRevisions })
    }
    if (pages.length > 128) throw new Error('SYNC_RESOURCE_LIMIT')
    if (!await queue.commitPull(pages, stamp, own)) again = true
    return { rows, revisions }
  }
  async function pull(own, force) {
    const server = session.status().server, config = await options(), permissionRequest = { operation: 'GET /permissions/me' }
    const permissionKey = requestKey(server, permissionRequest), previous = await queue.cacheGet(permissionKey)
    const stamp = queue.status().mutationRevision, permissions = await read(permissionRequest, own)
    const signature = value => JSON.stringify([...(Array.isArray(value) ? value : [])].map(row => JSON.stringify(row)).sort())
    if (previous && signature(previous.data?.data) !== signature(permissions.value.data?.data) || permissions.value.status) {
      const invalidation = await queue.invalidateReads([permissionKey], own, permissions.stamp)
      if (invalidation == null) { again = true; return }
      permissions.stamp = invalidation
    }
    if (!await queue.commitPull([permissions], queue.status().mutationRevision, own)) { again = true; return }
    if (permissions.value.status) return
    const requests = new Map(), add = request => requests.set(requestKey(server, request), request)
    add({ operation: 'GET /user/{id}', path: { id: String(session.status().user.id) } })
    for (const request of observed.values()) add(request)
    for (const [name, operation, query] of defaults) if (config[name] !== false) add({ operation, ...(query ? { query } : {}) })
    for (const key of await queue.cacheKeys()) {
      const request = requestFor(server, key)
      if (request && !(request.operation === 'GET /resources/{id}/members' && config.members === false) && request.operation !== permissionRequest.operation && request.operation !== 'GET /resources') add(request)
    }
    let done = 0
    progress = 0; emit()
    const roster = config.resources !== false ? await completeResources(own, stamp) : null
    if (roster && config.members !== false) for (const row of roster.rows) {
      const request = { operation: 'GET /resources/{id}/members', path: { id: String(row.id) } }
      const saved = await queue.control({ action: 'cacheGet', key: requestKey(server, request) })
      if (force || !saved || saved.status || saved.baseline?.['resource:' + row.id] !== roster.revisions['resource:' + row.id]) add(request)
    }
    for (const [key, request] of requests) {
      if (!current(own)) return
      const saved = await queue.cacheGet(key)
      const members = request.operation === 'GET /resources/{id}/members'
      if (members && roster && !force) {
        const cached = await queue.control({ action: 'cacheGet', key })
        const name = 'resource:' + request.path.id
        if (!cached?.status && cached?.baseline?.[name] && cached.baseline[name] === roster.revisions[name]) continue
      }
      if (!members || force || !saved || saved.status || now() - saved.ts >= intervalMs) {
        const before = queue.status().mutationRevision, row = await read(request, own)
        if (!await queue.commitPull([row], before, own)) again = true
        else observed.delete(key)
      }
      progress = Math.round(++done / requests.size * 100); emit()
    }
    if (!current(own)) return
    const repo = repository(), saved = await repo.setting({ key: timestampKey })
    await repo.saveSetting({ key: timestampKey, value: now(), expectedRevision: saved?.revision || 0 })
    if (current(own)) lastPullAt = now()
  }
  async function cycle(force, pullOnly) {
    const own = session.status().contextId
    if (!current(own)) return
    running = true; code = null; emit()
    try {
      if (lastPullAt == null) lastPullAt = (await repository().setting({ key: timestampKey }))?.value || null
      const alive = await session.probe()
      if (!current(own)) return
      if (reachable === false && alive) nextPullAt = 0
      reachable = alive; nextProbeAt = now() + (alive ? probeMs : intervalMs); emit()
      if (!alive) return
      if (session.status().mode === 'offline') await session.refresh()
      if (!current(own) || session.status().mode !== 'online' || session.status().needsLogin) { code = 'SYNC_LOGIN_REQUIRED'; return }
      const automatic = (await repository().setting({ key: 'queue.auto-sync' }))?.value !== false
      if (!force && !automatic) return
      if (!force && now() < nextPullAt) return
      if (!pullOnly) await queue.push(force)
      again = false
      if (!current(own)) return
      if (force || now() >= nextPullAt) {
        await pull(own, force)
        nextPullAt = now() + intervalMs
      }
    } catch (error) {
      if (current(own)) { code = /^SYNC_/.test(error.message) ? error.message : 'SYNC_UNAVAILABLE'; nextPullAt = now() + intervalMs }
    } finally { if (own === session.status().contextId) { running = false; progress = null; emit() } }
  }
  function run(force = false, pullOnly = false) {
    if (stopped || suspended) return Promise.resolve(status())
    if (flight) {
      if ((!force || flightForce) && (pullOnly || !flightPullOnly)) return flight
      if (!followUp) followUp = flight.then(() => { followUp = null; return run(true, pullOnly) })
      return followUp
    }
    const own = session.status().contextId
    flightForce = force; flightPullOnly = pullOnly
    flight = cycle(force, pullOnly).finally(() => { flight = null; if (!stopped && (again || own !== session.status().contextId)) { again = false; nextPullAt = 0; schedule() } }).then(status)
    return flight
  }
  function schedule() {
    if (stopped || suspended || refreshTimer) return
    refreshTimer = setTimeout(() => { refreshTimer = null; nextPullAt = 0; void run() }, debounceMs); refreshTimer.unref?.()
  }
  const unsubscribeSession = session.subscribe(() => {
    if (context !== session.status().contextId) { context = session.status().contextId; observed.clear(); reachable = null; lastPullAt = null; nextPullAt = 0; nextProbeAt = 0; code = null; emit(); schedule() }
  })
  const unsubscribeQueue = queue.subscribe(state => {
    if (state.mutationRevision !== observedMutation) { observedMutation = state.mutationRevision; again = Boolean(flight); schedule() }
  })
  const suspend = () => { suspended = true; generation++; for (const cancel of [...pauses]) cancel(); session.detach('desktop-sync') }
  const resume = () => { suspended = false; generation++; nextPullAt = 0; nextProbeAt = 0; schedule() }
  powerMonitor?.on('suspend', suspend); powerMonitor?.on('resume', resume)
  queue.installPull({ observe(request) {
    if (!identity() || !requestFor(session.status().server, requestKey(session.status().server, request))) return
    const key = requestKey(session.status().server, request)
    if (observed.has(key) || observed.size >= 128) return
    observed.set(key, { operation: request.operation, path: request.path || {}, query: request.query || {} }); again = Boolean(flight); schedule()
  } })
  timer = setInterval(() => { if (now() >= nextProbeAt && identity()) void run() }, Math.min(probeMs, intervalMs)); timer.unref?.()
  schedule()
  return {
    status, run,
    configure(enabled) {
      const result = configuration.then(() => saveOptions(enabled)); configuration = result.catch(() => {}); return result
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async stop() { stopped = true; clearInterval(timer); clearTimeout(refreshTimer); unsubscribeSession(); unsubscribeQueue(); powerMonitor?.removeListener('suspend', suspend); powerMonitor?.removeListener('resume', resume); session.detach('desktop-sync'); for (const cancel of [...pauses]) cancel(); await flight; await configuration; listeners.clear() },
  }
  async function saveOptions(enabled) {
    if (!enabled || Array.isArray(enabled) || Object.entries(enabled).some(([name, value]) => !domains.includes(name) || typeof value !== 'boolean')) throw new Error('SYNC_INVALID_REQUEST')
    const own = session.status().contextId, repo = repository(), previous = await repo.setting({ key: settingsKey })
    if (!current(own)) throw new Error('SESSION_CONTEXT_CHANGED')
    if (JSON.stringify(previous?.value) === JSON.stringify(enabled)) return
    await repo.saveSetting({ key: settingsKey, value: enabled, expectedRevision: previous?.revision || 0 })
    schedule()
  }
}
module.exports = { createSyncService, requestFor, requestKey, domains }
