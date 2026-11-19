'use strict'

const fs = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { bounded } = require('./protocol.cjs')
const { diagnosticEvent } = require('./command-diagnostics.cjs')
const CHANNEL = 'erp:diagnostics'
const KINDS = ['component', 'window', 'promise', 'chunk', 'navigation', 'api', 'pdf']
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null

function summaryStatus(service, state, stats, now) {
  const value = service.status()
  const storage = value.storage || {}, sync = value.sync || {}
  const queue = stats == null ? null : Object.fromEntries(['total', 'pending', 'ready', 'blocked', 'retry_waiting', 'unknown', 'conflict', 'rejected', 'retries'].map(key => [key, count(stats[key])]))
  if (queue) queue.oldest_age_ms = count(stats.oldest_created_at) != null && stats.oldest_created_at <= now ? now - stats.oldest_created_at : null
  return { needs_login: state.needsLogin === true, mode: ['online', 'offline', 'signedOut'].includes(state.mode) ? state.mode : 'unknown',
    storage: { phase: ['ready', 'starting', 'failed', 'closing', 'stopped'].includes(storage.phase) ? storage.phase : 'unknown',
      error_code: storage.code ? diagnosticEvent('diagnostic', { code: storage.code }).error_code : null },
    queue, sync: { reachable: typeof sync.reachable === 'boolean' ? sync.reachable : null,
      running: sync.running === true, last_pull_at: count(sync.lastPullAt) },
  }
}

function createDiagnosticsIpc({ ipcMain, trusted, session, service, storage, journal, showSaveDialog, version, now = Date.now }) {
  const previews = new Map(), rates = new Map()
  let observedContext = session?.status().contextId
  const stopSession = session?.subscribe(() => { const next = session.status().contextId; if (next !== observedContext) { observedContext = next; previews.clear(); rates.clear() } })
  let disposed = false, saving = false
  const error = code => ({ ok: false, error: code })
  const matches = (window, request) => !disposed && request.contextId === session?.status().contextId && !window.contents.isDestroyed()
  ipcMain.handle(CHANNEL, async (event, request) => {
    const window = trusted(event)
    if (!window) return error('DIAGNOSTICS_UNTRUSTED')
    if (!bounded(request, 4096) || !request || !['record', 'preview', 'save'].includes(request.action)) return error('DIAGNOSTICS_INVALID')
    const keys = ['action', 'contextId', ...(request.action === 'record' ? ['kind', 'diagnostic'] : request.action === 'save' ? ['snapshotId'] : [])]
    if (Object.keys(request).some(key => !keys.includes(key)) || !matches(window, request)) return error('DIAGNOSTICS_CONTEXT_CHANGED')
    const owner = window.contents.id
    if (request.action === 'record') {
      if (!KINDS.includes(request.kind)) return error('DIAGNOSTICS_INVALID')
      const rate = rates.get(owner) || { at: now(), count: 0 }
      if (now() - rate.at >= 1000) { rate.at = now(); rate.count = 0 }
      rates.set(owner, rate)
      if (++rate.count > 8) return error('DIAGNOSTICS_BUSY')
      const row = request.diagnostic || {}
      try { journal.record('renderer', row.event, { code: row.error_code, response: { status: row.status, data: { error: { code: row.error_code } } } },
        { request_id: row.request_id, duration_ms: row.duration_ms, kind: request.kind }, 'failed') } catch { return error('DIAGNOSTICS_UNAVAILABLE') }
      return { ok: true }
    }
    try {
      if (request.action === 'preview') {
        const cached = previews.get(owner)
        if (cached && cached.context === request.contextId && cached.document === window.document && now() - window.diagnosticPreviewAt < 1000) {
          return { ok: true, value: { contextId: request.contextId, snapshotId: cached.snapshotId, report: JSON.parse(cached.text) } }
        }
        if (!cached && window.diagnosticPreviewAt != null && now() - window.diagnosticPreviewAt < 1000 && window.diagnosticContext === request.contextId) return error('DIAGNOSTICS_BUSY')
        window.diagnosticContext = request.contextId
        window.diagnosticPreviewAt = now()
        const state = session.status(), ownDocument = window.document
        let stats = null
        const observeStorage = journal.bind('worker', 'diagnostic')
        try {
          if (state.user && state.mode !== 'signedOut') stats = await storage.forScope({ server: state.server, accountId: state.user.id }).queueStats()
        } catch (error) { observeStorage(error, null, 'failed') }
        const report = await journal.report()
        if (!matches(window, request) || ownDocument !== window.document || !report) return error('DIAGNOSTICS_CONTEXT_CHANGED')
        report.state = summaryStatus(service, state, stats, now())
        report.runtime = Object.fromEntries(['electron', 'node'].flatMap(key => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(process.versions[key] || '') ? [[key, process.versions[key]]] : []))
        report.runtime.os = ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown'
        const text = JSON.stringify(report, null, 2)
        if (Buffer.byteLength(text) > 512 * 1024) return error('DIAGNOSTICS_LIMIT')
        if (!previews.has(owner) && previews.size >= 2) previews.delete(previews.keys().next().value)
        const snapshotId = randomUUID()
        previews.set(owner, { snapshotId, text, context: request.contextId, document: window.document })
        return { ok: true, value: { contextId: request.contextId, snapshotId, report } }
      }
      const preview = previews.get(owner)
      if (saving || !preview || preview.snapshotId !== request.snapshotId || preview.context !== request.contextId || preview.document !== window.document) return error('DIAGNOSTICS_STALE_PREVIEW')
      saving = true
      try {
        const result = await showSaveDialog(window.contents, `Clockwork-diagnostics-v${/^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown'}-${now()}.json`)
        if (!matches(window, request) || preview.document !== window.document || previews.get(owner) !== preview) return error('DIAGNOSTICS_CONTEXT_CHANGED')
        if (result.canceled || !result.filePath) return { ok: true, value: { saved: false } }
        // Only a native chooser supplies the path; never overwrite an existing profile/file.
        const file = await fs.open(result.filePath, 'wx', 0o600)
        let completed = false
        try {
          if (!matches(window, request) || preview.document !== window.document || previews.get(owner) !== preview) return error('DIAGNOSTICS_CONTEXT_CHANGED')
          await file.writeFile(preview.text); await file.sync()
          completed = matches(window, request) && preview.document === window.document && previews.get(owner) === preview
          if (!completed) return error('DIAGNOSTICS_CONTEXT_CHANGED')
        } finally { await file.close(); if (!completed) await fs.unlink(result.filePath).catch(() => {}) }
        return { ok: true, value: { saved: true } }
      } finally { saving = false }
    } catch { return error('DIAGNOSTICS_UNAVAILABLE') }
  })
  return { detach(owner) { previews.delete(owner); rates.delete(owner) }, dispose() { disposed = true; stopSession?.(); previews.clear(); rates.clear(); ipcMain.removeHandler(CHANNEL) } }
}
module.exports = { CHANNEL, createDiagnosticsIpc, summaryStatus }
