'use strict'

const { randomUUID } = require('node:crypto')
const routes = require('./api-routes.json')
const { bounded } = require('./protocol.cjs')

function normalizeServer(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/', '/api/v1', '/api/v1/'].includes(url.pathname)) throw new Error('SESSION_INVALID_SERVER')
  return url.origin + '/api/v1'
}
function expiresAt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000 || 0 } catch { return 0 }
}
function createSessionService({ vault, fetch: fetchRequest, onIdentity = () => {}, interceptApi, now = Date.now }) {
  let server = null, user = null, access = null, refresh = null, mode = 'signedOut', persistent = false
  let contextId = randomUUID(), revision = 0, epoch = 0, pending = null, stopped = false
  let offlineAvailable = false, needsLogin = false, activeRequests = 0
  const listeners = new Set(), requests = new Map()
  const status = () => ({ server, user: user && structuredClone(user), mode, persistent, offlineAvailable, needsLogin, contextId, revision, expiresAt: expiresAt(access || '') })
  function emit(identity = false) {
    revision++
    if (identity) { contextId = randomUUID(); onIdentity(status()) }
    for (const listener of listeners) { try { listener(status()) } catch { /* Views cannot block the session owner. */ } }
  }
  function reset() {
    epoch++; access = null; refresh = null; user = null; mode = 'signedOut'; offlineAvailable = false; needsLogin = false; persistent = false
    for (const request of requests.values()) request.controller.abort()
    emit(true)
  }
  async function wire(base, route, method, body, headers = {}, signal) {
    if (activeRequests >= 64) throw new Error('SESSION_BUSY')
    activeRequests++
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    try {
      const response = await fetchRequest(base + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
      // No headers (in particular Set-Cookie) cross the process boundary.
      const text = await response.text()
      if (text.length > 8 * 1024 * 1024) throw new Error('SESSION_RESPONSE_LIMIT')
      const data = text ? JSON.parse(text) : null
      if (!bounded(data, 8 * 1024 * 1024)) throw new Error('SESSION_RESPONSE_LIMIT')
      return { status: response.status, data, ...(response.headers?.get('Operation-Status') ? { operationStatus: response.headers.get('Operation-Status') } : {}), ...(response.headers?.get('Retry-After') ? { retryAfter: Number(response.headers.get('Retry-After')) || 0 } : {}) }
    } finally { activeRequests--; clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  async function revoke(base, token) {
    if (token) { try { await wire(base, '/auth/logout', 'POST', { refresh_token: token }) } catch { /* Local logout is final even without a server response. */ } }
  }
  async function accept(result, own, base, expectedUser) {
    const data = result.data?.data
    if (result.status !== 200 || !data?.access_token || !data.refresh_token || !Number.isSafeInteger(data.user?.id) || !data.user?.username) throw new Error('SESSION_INVALID_RESPONSE')
    if (expectedUser != null && data.user.id !== expectedUser) throw new Error('SESSION_ACCOUNT_MISMATCH')
    data.user = Object.fromEntries(Object.entries(data.user).filter(([key]) => ['id', 'username', 'preset', 'name', 'last_name', 'first_name', 'middle_name'].includes(key)))
    if (own !== epoch || base !== server || stopped) { void revoke(base, data.refresh_token); return status() }
    const cipher = await vault.encrypt(data.refresh_token)
    if (own !== epoch) { void revoke(base, data.refresh_token); return status() }
    await vault.put(base, { user: data.user, cipher, eligible: true, needsLogin: !cipher })
    if (own !== epoch) { void revoke(base, data.refresh_token); return status() }
    const changed = user?.id !== data.user.id || mode === 'signedOut'
    user = data.user; access = data.access_token; refresh = data.refresh_token; mode = 'online'; persistent = Boolean(cipher); offlineAvailable = true; needsLogin = false
    emit(changed)
    return status()
  }
  async function invalidate(own, base) {
    if (own !== epoch || base !== server) return
    await vault.put(base, { user, eligible: false, needsLogin: true })
    if (own !== epoch) return
    reset(); needsLogin = true; emit()
  }
  async function renew() {
    if (stopped || !server || !user || mode === 'signedOut' || needsLogin) return status()
    if (pending) return pending
    const own = epoch, base = server
    pending = (async () => {
      // An unavailable network must not consume the last saved refresh token.
      try { if ((await wire(base, '/health', 'GET')).status >= 500) return status() } catch { return status() }
      if (own !== epoch) return status()
      const token = refresh || await vault.decrypt(vault.get(base).cipher)
      if (own !== epoch) return status()
      if (!token) { needsLogin = true; persistent = false; emit(); return status() }
      // Durable intent precedes send; a crash or lost reply can never replay token.
      await vault.put(base, { user, eligible: true, needsLogin: true })
      if (own !== epoch) return status()
      refresh = null
      try {
        const result = await wire(base, '/auth/refresh', 'POST', { refresh_token: token })
        if (result.status === 401 || result.status === 403) { await invalidate(own, base); return status() }
        if (result.status !== 200) throw new Error('SESSION_REFRESH_UNCERTAIN')
        return await accept(result, own, base, user?.id)
      } catch {
        if (own === epoch) { needsLogin = true; persistent = false; access = null; mode = 'offline'; emit() }
        return status()
      }
    })().finally(() => { pending = null })
    return pending
  }
  return {
    status,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async selectServer(value) {
      const next = normalizeServer(value)
      if (server === next) return status()
      reset(); server = next
      const record = vault.get(next)
      user = record.user || null; offlineAvailable = Boolean(record.eligible && user); needsLogin = Boolean(record.needsLogin)
      mode = offlineAvailable ? 'offline' : 'signedOut'; persistent = Boolean(record.cipher)
      emit(true)
      return status()
    },
    async login(username, password) {
      if (!server || typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || username.length > 256 || password.length > 4096) throw new Error('SESSION_INVALID_LOGIN')
      const base = server
      reset()
      const own = epoch
      // Persist logout first: a failed login never restores the prior account.
      await vault.put(base, { eligible: false, needsLogin: true })
      if (own !== epoch) return status()
      const result = await wire(base, '/auth/login', 'POST', { username: username.trim(), password })
      if (result.status !== 200) return { ...status(), error: result.data?.error || { message: 'SESSION_LOGIN_FAILED' } }
      return accept(result, own, base)
    },
    refresh: renew,
    async logout() {
      const base = server, previous = user, saved = base && vault.get(base).cipher, current = refresh
      reset()
      const own = epoch
      if (base) await vault.put(base, { user: previous, eligible: false, needsLogin: true })
      const token = current || await vault.decrypt(saved)
      if (own !== epoch) return status()
      void revoke(base, token)
      return status()
    },
    enterOffline(username) {
      if (!offlineAvailable || !user || (username && username !== user.username)) throw new Error('SESSION_NO_LOCAL_PROFILE')
      mode = 'offline'; emit(); return status()
    },
    async probe() {
      if (!server) return false
      try { return (await wire(server, '/health', 'GET')).status < 500 } catch { return false }
    },
    async api(owner, request, internal = {}) {
      const route = routes.find(item => item.operation === request.operation)
      if (!route) throw new Error('SESSION_INVALID_REQUEST')
      if (request.contextId !== contextId) throw new Error('SESSION_CONTEXT_CHANGED')
      if (!server || !user || mode === 'signedOut') return { status: 401, data: { error: { code: 'UNAUTHORIZED' } } }
      if (interceptApi && !internal.bypassQueue) return interceptApi(request, options => this.api(owner, request, { bypassQueue: true, ...options }))
      if (mode !== 'online') throw new Error('SESSION_OFFLINE')
      if (requests.size >= 64 || requests.has(request.requestId)) throw new Error('SESSION_BUSY')
      let pathname = route.path
      const params = request.path || {}, query = request.query || {}
      for (const name of [...route.path.matchAll(/\{([^}]+)\}/g)].map(item => item[1])) {
        const value = String(params[name] ?? '')
        const numeric = route.pathTypes[name] === 'integer'
        if (numeric ? !/^[1-9]\d*$/.test(value) : !value || value.length > 256 || ['.', '..'].includes(value) || /[\/\\?#\x00-\x1f]/.test(value)) throw new Error('SESSION_INVALID_PATH')
        pathname = pathname.replace(`{${name}}`, encodeURIComponent(value))
      }
      if (Object.keys(query).some(key => !route.query.includes(key))) throw new Error('SESSION_INVALID_QUERY')
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error('SESSION_INVALID_QUERY')
        search.append(key, String(value))
      }
      if (search.size) pathname += '?' + search
      if (request.key != null && (typeof request.key !== 'string' || !/^[\w:.-]{1,200}$/.test(request.key))) throw new Error('SESSION_INVALID_KEY')
      const base = server, own = epoch, controller = new AbortController(), read = route.method === 'GET'
      requests.set(request.requestId, { owner, controller, read })
      try {
        if (!access || expiresAt(access) <= now()) await renew()
        if (own !== epoch) throw new Error('SESSION_CONTEXT_CHANGED')
        if (!access) return { status: 401, data: { error: { code: 'UNAUTHORIZED' } } }
        const headers = () => ({ Authorization: `Bearer ${access}`, 'Accept-Language': request.locale === 'en' ? 'en' : 'ru', ...(request.key ? { 'Idempotency-Key': request.key } : {}), ...(request.operationId ? { 'Operation-Id': request.operationId } : {}), ...(internal.revisionProtocol ? { 'Revision-Protocol': '1' } : {}), ...(request.viewUser ? { 'X-View-User-ID': String(request.viewUser) } : {}) })
        const sent = access
        let result = await wire(base, pathname, route.method, request.body, headers(), controller.signal)
        if (result.status === 401) {
          if (access === sent) await renew()
          if (own === epoch && access && access !== sent) result = await wire(base, pathname, route.method, request.body, headers(), controller.signal)
        }
        if (own !== epoch || request.contextId !== contextId) throw new Error('SESSION_CONTEXT_CHANGED')
        return result
      } catch (error) {
        if (own !== epoch || request.contextId !== contextId) throw new Error('SESSION_CONTEXT_CHANGED')
        throw error
      } finally { requests.delete(request.requestId) }
    },
    detach(owner) { for (const request of requests.values()) if (request.owner === owner && request.read) request.controller.abort() },
    cancel(owner, id) { const request = requests.get(id); if (request?.owner === owner && request.read) request.controller.abort() },
    tick() { if (mode !== 'signedOut' && !needsLogin && expiresAt(access || '') - now() <= 120000) return renew(); return Promise.resolve(status()) },
    stop() { stopped = true; reset(); listeners.clear() },
  }
}
module.exports = { createSessionService, normalizeServer }
