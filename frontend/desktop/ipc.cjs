'use strict'

const { validate } = require('./protocol.cjs')
const sessionIpc = require('./session-ipc.cjs')
const REQUEST = 'erp:service-request', EVENT = 'erp:service-state'

function createDesktopIpc({ ipcMain, service, origin, session, queue }) {
  const windows = new Map()
  let disposed = false
  const trusted = event => {
    const window = windows.get(event.sender.id)
    if (!window || event.sender !== window.contents || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null
    try {
      const url = new URL(event.senderFrame.url)
      return url.origin === origin && !url.username && !url.password ? window : null
    } catch { return null }
  }
  const send = window => {
    if (!window.subscription || window.awaiting != null || window.contents.isDestroyed()) return
    const state = service.status()
    window.awaiting = state.revision
    try { window.contents.send(EVENT, { subscriptionId: window.subscription, state }) } catch { window.awaiting = null }
  }
  const unsubscribeService = service.subscribe(() => { for (const window of windows.values()) { window.dirty = true; send(window) } })
  const unavailable = code => ({ kind: 'unavailable', code, message: code })
  ipcMain.handle(REQUEST, async (event, request) => {
    const window = trusted(event)
    if (!window) return { ok: false, error: { kind: 'forbidden', code: 'DESKTOP_UNTRUSTED_SENDER', message: 'DESKTOP_UNTRUSTED_SENDER' } }
    if (!validate(request)) return { ok: false, error: { kind: 'validation', code: 'DESKTOP_INVALID_REQUEST', message: 'DESKTOP_INVALID_REQUEST' } }
    const owner = window.contents.id + ':' + window.document
    switch (request.kind) {
      case 'status': return { ok: true, value: service.status() }
      case 'read': return { ok: true, value: await service.read(owner, request) }
      case 'command': return { ok: true, value: await service.execute(owner, request) }
      case 'cancel': return { ok: true, value: service.cancel(owner, request.requestId) }
      case 'subscribe':
        window.subscription = request.subscriptionId; window.awaiting = null; window.dirty = false; send(window)
        return { ok: true, value: null }
      case 'unsubscribe':
        if (window.subscription === request.subscriptionId) { window.subscription = null; window.awaiting = null }
        return { ok: true, value: null }
      case 'ack':
        if (window.subscription === request.subscriptionId && window.awaiting === request.revision) {
          window.awaiting = null
          if (window.dirty && service.status().revision > request.revision) { window.dirty = false; send(window) }
        }
        return { ok: true, value: null }
      default: return { ok: false, error: unavailable('DESKTOP_UNAVAILABLE') }
    }
  })
  const sendSession = window => {
    if (!session || window.sessionAwaiting != null || window.contents.isDestroyed()) return
    const state = session.status()
    window.sessionAwaiting = state.revision
    window.sessionDirty = false
    try { window.contents.send(sessionIpc.EVENT, state) } catch { window.sessionAwaiting = null }
  }
  const unsubscribeSession = session?.subscribe(() => {
    for (const window of windows.values()) { window.sessionDirty = true; sendSession(window) }
  })
  if (session) ipcMain.handle(sessionIpc.CHANNEL, async (event, request) => {
    const window = trusted(event)
    if (!window) return { ok: false, error: 'DESKTOP_UNTRUSTED_SENDER' }
    if (!sessionIpc.valid(request)) return { ok: false, error: 'SESSION_INVALID_REQUEST' }
    if (request.action === 'ack') {
      if (window.sessionAwaiting === request.revision) {
        window.sessionAwaiting = null
        if (window.sessionDirty) sendSession(window)
      }
      return { ok: true }
    }
    return sessionIpc.dispatch(session, window.contents.id + ':' + window.document, request)
  })
  if (queue) ipcMain.handle('erp:queue', async (event, request) => {
    if (!trusted(event)) return { ok: false, error: 'DESKTOP_UNTRUSTED_SENDER' }
    const fields = { configure: ['autoSync'], enqueue: ['operationId', 'input'], cachePut: ['key', 'value'], list: ['after'], push: [], retry: ['operationId'], discard: ['operationIds'], cacheGet: ['key'], cacheKeys: [] }
    if (!request || !Object.hasOwn(fields, request.action) || Object.keys(request).some(key => !['action', 'contextId'].includes(key) && !fields[request.action].includes(key)) || !require('./protocol.cjs').bounded(request)) return { ok: false, error: 'COMMAND_INVALID_REQUEST' }
    if (request.action === 'retry' && !/^[A-Za-z0-9._:-]{1,128}$/.test(request.operationId || '') || request.action === 'discard' && (!Array.isArray(request.operationIds) || request.operationIds.length > 200 || !request.operationIds.every(id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id))) || request.action === 'cacheGet' && (typeof request.key !== 'string' || request.key.length > 8192)) return { ok: false, error: 'COMMAND_INVALID_REQUEST' }
    if (request.action === 'list' && request.after != null && (!Number.isSafeInteger(request.after) || request.after < 0)) return { ok: false, error: 'COMMAND_INVALID_REQUEST' }
    if (request.contextId !== queue.status().contextId) return { ok: false, error: 'COMMAND_SESSION_UNAVAILABLE' }
    try { const value = await queue.control(request); if (request.contextId !== queue.status().contextId) return { ok: false, error: 'COMMAND_SESSION_UNAVAILABLE' }; if (!require('./protocol.cjs').bounded(value, 8 * 1024 * 1024)) throw new Error('COMMAND_RESULT_LIMIT'); return { ok: true, value } } catch (error) { return { ok: false, error: /^STORAGE_|^COMMAND_/.test(error.code || error.message) ? error.code || error.message : 'COMMAND_UNAVAILABLE' } }
  })
  ipcMain.handle('erp:app-version', event => {
    if (!trusted(event)) throw new Error('DESKTOP_UNTRUSTED_SENDER')
    const state = service.status()
    return { version: state.version, electron: state.electron }
  })
  function attach(contents) {
    if (disposed || windows.has(contents.id)) throw new Error('Desktop IPC attachment is unavailable')
    const window = { contents, document: 0, subscription: null, awaiting: null, dirty: false, sessionAwaiting: null, sessionDirty: false }
    windows.set(contents.id, window)
    const leaveDocument = () => {
      session?.detach(contents.id + ':' + window.document)
      service.detach(contents.id + ':' + window.document)
      window.sessionAwaiting = null; window.sessionDirty = false
      window.document++; window.subscription = null; window.awaiting = null; window.dirty = false
    }
    const navigation = (_, __, inPlace, mainFrame) => { if (mainFrame && !inPlace) leaveDocument() }
    const destroyed = () => {
      leaveDocument(); windows.delete(contents.id)
      contents.removeListener('did-start-navigation', navigation)
      contents.removeListener('render-process-gone', leaveDocument)
      contents.removeListener('destroyed', destroyed)
    }
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', leaveDocument)
    contents.once('destroyed', destroyed)
    window.cleanup = destroyed
    return destroyed
  }
  return { attach, dispose() {
    if (disposed) return
    disposed = true
    unsubscribeService()
    unsubscribeSession?.()
    if (session) ipcMain.removeHandler(sessionIpc.CHANNEL)
    for (const window of [...windows.values()]) window.cleanup()
    windows.clear()
    if (queue) ipcMain.removeHandler('erp:queue')
    ipcMain.removeHandler(REQUEST); ipcMain.removeHandler('erp:app-version')
  } }
}

module.exports = { createDesktopIpc, REQUEST, EVENT }
