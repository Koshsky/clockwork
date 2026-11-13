'use strict'
const { randomUUID } = require('node:crypto')
const { businessBindings, businessRequest } = require('./business-request.cjs')
const error = (kind, code, message = code) => ({ kind, code, message })
const refused = result => result.data?.error && (result.data.error.code != null || result.data.error.message)
const responseKind = result => kind(result.status >= 400 ? result.status : ({ UNAUTHORIZED: 401, INVALID_TOKEN: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, VALIDATION_ERROR: 400, BAD_REQUEST: 400 }[result.data?.error?.code] || Number(result.data?.error?.code) || result.status))
const kind = status => status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : status === 400 || status === 422 ? 'validation' : status >= 500 || status === 429 ? 'unavailable' : 'unexpected'
function createBusinessAdapters({ session, queue }) {
  const reads = {}, commands = {}
  const current = context => {
    const state = session.status()
    if (context.signal.aborted || state.mode === 'signedOut' || !state.user || context.scope.server !== state.server || context.scope.accountId !== state.user.id) throw new Error('SESSION_CONTEXT_CHANGED')
    return state.contextId
  }
  async function send(operation, input, context, read) {
    const own = current(context), requestId = randomUUID(), request = businessRequest(operation, input)
    if (operation === 'account.profile' && !request.path.id) request.path.id = String(session.status().user.id)
    const abort = () => session.cancel('business-ports', requestId)
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      const result = await session.api('business-ports', {
        operation: request.route, path: request.path, query: request.query, body: request.body,
        contextId: own, requestId, locale: context.locale,
        ...(read ? { snapshotOnly: context.source === 'snapshot' } : { key: context.operationId, ...(context.preconditions ? { preconditions: context.preconditions } : {}), ...(context.temporaryId != null ? { tempId: context.temporaryId } : {}) }),
      })
      if (own !== current(context)) throw new Error('SESSION_CONTEXT_CHANGED')
      return { ...result, sessionContextId: own }
    } finally { context.signal.removeEventListener('abort', abort) }
  }
  for (const binding of businessBindings) {
    if (binding.kind === 'read') reads[binding.operation] = async (input, context) => {
      try {
        const result = await send(binding.operation, input, context, true)
        if (result.status === 503 && result.data?.error?.code === 'LOCAL_SNAPSHOT_MISSING') return { status: 'missing' }
        if (result.status < 200 || result.status >= 300 || refused(result)) return { status: 'failed', error: error(responseKind(result), String(result.data?.error?.code || result.status), result.data?.error?.message) }
        const raw = result.data?.data, value = binding.unwrap ? raw?.[binding.unwrap] : raw
        const data = binding.page ? { ...value, limit: input?.limit ?? 50, offset: input?.offset ?? 0 } : value
        return { status: 'ok', data, source: result.localSnapshot ? 'snapshot' : context.source, ...(result.baseline ? { baseline: result.baseline } : {}) }
      } catch (cause) { return context.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: error(/^(STORAGE|COMMAND)_/.test(cause.message) ? 'storage' : 'unavailable', /^(STORAGE|COMMAND|SESSION)_[A-Z_]+$/.test(cause.message) ? cause.message : 'DESKTOP_READ_FAILED') } }
    }
    else commands[binding.operation] = async (input, context) => {
      try {
        const result = await send(binding.operation, input, context, false)
        const metadata = { operationId: result.operationId || context.operationId, sessionContextId: result.sessionContextId, ...(result.baseline ? { baseline: result.baseline } : {}) }
        if (result.queued || result.status === 202) return { status: 'queued', ...metadata }
        if (result.status >= 200 && result.status < 300 && !refused(result)) return { status: 'confirmed', data: result.data?.data ?? null, ...metadata }
        return { status: result.status >= 500 || result.status === 429 ? 'unknown' : result.status === 409 ? 'conflict' : 'rejected', error: error(responseKind(result), String(result.data?.error?.code || result.status), result.data?.error?.message), ...metadata }
      } catch (cause) { return { status: 'unknown', error: error(/^(STORAGE|COMMAND)_/.test(cause.message) ? 'storage' : 'unavailable', /^(STORAGE|COMMAND|SESSION)_[A-Z_]+$/.test(cause.message) ? cause.message : 'DESKTOP_COMMAND_FAILED') } }
    }
  }
  reads['resource.header'] = async (input, context) => {
    const own = current(context), user = session.status().user
    const owner = user.preset === 'admin' ? input.ownerId ?? 'all' : user.id
    const cached = await queue.control({ action: 'cacheGet', key: '/local/resource-header?owner_id=' + owner })
    if (own !== current(context)) return { status: 'cancelled' }
    if (!cached) return { status: 'missing' }
    if (cached.status >= 400) return { status: 'failed', error: error(kind(cached.status), String(cached.status)) }
    return { status: 'ok', data: cached.data, source: 'snapshot', coverage: { completeness: 'complete' } }
  }
  return { reads, commands }
}
module.exports = { createBusinessAdapters }
