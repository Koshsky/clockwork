'use strict'

const { bounded } = require('./protocol.cjs')
const CHANNEL = 'erp:session', EVENT = 'erp:session-state'
const shapes = {
  status: [], selectServer: ['server'], login: ['username', 'password'], refresh: [], logout: [], enterOffline: ['username'], probe: [],
  ack: ['revision'], api: ['operation', 'contextId', 'requestId', 'path', 'query', 'body', 'key', 'locale', 'viewUser', 'tempId', 'preconditions', 'snapshotOnly'], cancel: ['requestId'],
}
function valid(request) {
  if (!bounded(request) || !request || typeof request !== 'object' || !Object.hasOwn(shapes, request.action)) return false
  if (Object.keys(request).some(key => key !== 'action' && !shapes[request.action].includes(key))) return false
  if (request.action === 'ack') return Number.isSafeInteger(request.revision) && request.revision >= 0
  if (request.action === 'api') return (request.snapshotOnly == null || typeof request.snapshotOnly === 'boolean' && typeof request.operation === 'string' && request.operation.startsWith('GET ')) && (request.tempId == null || Number.isSafeInteger(request.tempId) && request.tempId < 0) && typeof request.operation === 'string' && typeof request.contextId === 'string' && typeof request.requestId === 'string' && /^[\w:.-]{1,128}$/.test(request.requestId) && (request.path == null || typeof request.path === 'object' && !Array.isArray(request.path)) && (request.query == null || typeof request.query === 'object' && !Array.isArray(request.query)) && (request.viewUser == null || Number.isSafeInteger(request.viewUser) && request.viewUser > 0)
  if (request.action === 'login') return typeof request.username === 'string' && typeof request.password === 'string'
  if (request.action === 'selectServer') return typeof request.server === 'string'
  if (request.action === 'enterOffline') return request.username == null || typeof request.username === 'string'
  if (request.action === 'cancel') return typeof request.requestId === 'string'
  return true
}
async function dispatch(session, owner, request) {
  if (!valid(request)) return { ok: false, error: 'SESSION_INVALID_REQUEST' }
  try {
    let value
    switch (request.action) {
      case 'selectServer': value = await session.selectServer(request.server); break
      case 'login': value = await session.login(request.username, request.password); break
      case 'enterOffline': value = session.enterOffline(request.username); break
      case 'api': value = await session.api(owner, request); break
      case 'cancel': value = session.cancel(owner, request.requestId); break
      default: value = await session[request.action]()
    }
    return { ok: true, value }
  } catch (error) {
    // Native errors can include network URLs, headers or vault paths.
    const known = ['SESSION_CONTEXT_CHANGED', 'SESSION_INVALID_REQUEST', 'SESSION_INVALID_PATH', 'SESSION_INVALID_QUERY', 'SESSION_INVALID_KEY', 'SESSION_BUSY']
    const code = error?.code || error?.message
    return { ok: false, error: known.includes(code) || /^(STORAGE|COMMAND)_[A-Z0-9_]+$/.test(code) ? code : 'SESSION_UNAVAILABLE' }
  }
}
module.exports = { CHANNEL, EVENT, dispatch, valid }
