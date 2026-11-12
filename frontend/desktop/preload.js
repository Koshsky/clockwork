'use strict'

const { contextBridge, ipcRenderer } = require('electron')
const REQUEST = 'erp:service-request', EVENT = 'erp:service-state'
const listeners = new Map()
let subscriptionId = null

function bounded(request) {
  let nodes = 0, bytes = 0
  const visit = (value, depth) => {
    if (++nodes > 20000 || depth > 16) return false
    if (value == null || value === undefined || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') { bytes += new TextEncoder().encode(value).byteLength; return value.length <= 65536 && bytes <= 1024 * 1024 }
    if (Array.isArray(value)) return value.length <= 5000 && value.every(item => visit(item, depth + 1))
    return typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length <= 256 && Object.entries(value).every(([key, item]) => key.length <= 4096 && !['__proto__', 'constructor', 'prototype'].includes(key) && (bytes += new TextEncoder().encode(key).byteLength) <= 1024 * 1024 && visit(item, depth + 1))
  }
  try { return visit(request, 0) && new TextEncoder().encode(JSON.stringify(request)).byteLength <= 1024 * 1024 } catch { return false }
}
const invalid = () => ({ kind: 'validation', code: 'DESKTOP_INVALID_REQUEST', message: 'DESKTOP_INVALID_REQUEST' })

async function invoke(request) {
  if (!bounded(request)) throw new Error('DESKTOP_INVALID_REQUEST')
  const result = await ipcRenderer.invoke(REQUEST, { ...request, protocol: 1 })
  if (!result?.ok) throw new Error(result?.error?.code || 'DESKTOP_UNAVAILABLE')
  return result.value
}
function stopSubscription() {
  const previous = subscriptionId
  subscriptionId = null
  if (previous) void invoke({ kind: 'unsubscribe', subscriptionId: previous }).catch(() => {})
}
ipcRenderer.on(EVENT, (_, message) => {
  if (message?.subscriptionId !== subscriptionId || !message?.state) return
  for (const listener of listeners.values()) {
    try { listener(message.state) } catch { /* Listener failures cannot block acknowledgements. */ }
  }
  void invoke({ kind: 'ack', subscriptionId, revision: message.state.revision }).catch(() => {})
})

const sessionListeners = new Set()
ipcRenderer.on('erp:session-state', (_, state) => {
  for (const listener of sessionListeners) { try { listener(state) } catch { /* Other windows remain independent. */ } }
  void sessionRequest({ action: 'ack', revision: state.revision }).catch(() => {})
})
async function sessionRequest(request) {
  if (!bounded(request)) throw new Error('SESSION_INVALID_REQUEST')
  const result = await ipcRenderer.invoke('erp:session', request)
  if (!result?.ok) throw new Error(result?.error || 'SESSION_UNAVAILABLE')
  return result.value
}

// The envelope and channels belong to preload; page code never gets Electron
// events, ipcRenderer, filesystem paths, SQL or an arbitrary network proxy.
contextBridge.exposeInMainWorld('erpDesktop', {
  isElectron: true,
  appVersion: () => ipcRenderer.invoke('erp:app-version'),
  session: {
    status: () => sessionRequest({ action: 'status' }),
    selectServer: server => sessionRequest({ action: 'selectServer', server }),
    login: (username, password) => sessionRequest({ action: 'login', username, password }),
    refresh: () => sessionRequest({ action: 'refresh' }),
    logout: () => sessionRequest({ action: 'logout' }),
    enterOffline: username => sessionRequest({ action: 'enterOffline', username }),
    probe: () => sessionRequest({ action: 'probe' }),
    api: request => sessionRequest({ ...request, action: 'api' }),
    cancel: requestId => sessionRequest({ action: 'cancel', requestId }),
    subscribe: listener => {
      if (typeof listener !== 'function' || sessionListeners.size >= 64) throw new Error('Invalid session subscription')
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
  },
  service: {
    status: () => invoke({ kind: 'status' }),
    read: async request => {
      if (!bounded(request)) return { status: 'failed', error: invalid() }
      const result = await ipcRenderer.invoke(REQUEST, { ...request, kind: 'read', protocol: 1 })
      return result?.ok ? result.value : { status: 'failed', error: result?.error || { kind: 'unavailable', message: 'DESKTOP_UNAVAILABLE' } }
    },
    execute: async request => {
      if (!bounded(request)) return { status: 'rejected', error: invalid() }
      const result = await ipcRenderer.invoke(REQUEST, { ...request, kind: 'command', protocol: 1 })
      return result?.ok ? result.value : { status: 'rejected', operationId: request?.operationId, error: result?.error || { kind: 'unavailable', message: 'DESKTOP_UNAVAILABLE' } }
    },
    cancel: requestId => invoke({ kind: 'cancel', requestId }),
    subscribe: listener => {
      if (typeof listener !== 'function' || listeners.size >= 64) throw new Error('Invalid desktop subscription')
      const token = {}
      listeners.set(token, listener)
      if (!subscriptionId) {
        const own = globalThis.crypto.randomUUID()
        subscriptionId = own
        void invoke({ kind: 'subscribe', subscriptionId: own }).catch(() => { if (subscriptionId === own) subscriptionId = null })
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(token)
        if (!listeners.size) stopSubscription()
      }
    },
  },
})
