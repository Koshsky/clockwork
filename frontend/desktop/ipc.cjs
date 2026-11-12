'use strict'

const { validate } = require('./protocol.cjs')
const REQUEST = 'erp:service-request', EVENT = 'erp:service-state'

function createDesktopIpc({ ipcMain, service, origin }) {
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
  ipcMain.handle('erp:app-version', event => {
    if (!trusted(event)) throw new Error('DESKTOP_UNTRUSTED_SENDER')
    const state = service.status()
    return { version: state.version, electron: state.electron }
  })
  function attach(contents) {
    if (disposed || windows.has(contents.id)) throw new Error('Desktop IPC attachment is unavailable')
    const window = { contents, document: 0, subscription: null, awaiting: null, dirty: false }
    windows.set(contents.id, window)
    const leaveDocument = () => {
      service.detach(contents.id + ':' + window.document)
      window.document++; window.subscription = null; window.awaiting = null; window.dirty = false
    }
    const navigation = (_, __, ___, mainFrame) => { if (mainFrame) leaveDocument() }
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
    for (const window of [...windows.values()]) window.cleanup()
    windows.clear()
    ipcMain.removeHandler(REQUEST); ipcMain.removeHandler('erp:app-version')
  } }
}

module.exports = { createDesktopIpc, REQUEST, EVENT }
