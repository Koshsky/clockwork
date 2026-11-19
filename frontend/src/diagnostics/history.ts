import { readonly, shallowRef } from 'vue'
import { diagnosticEvent, type DiagnosticEvent } from '@/domain/diagnostics'

const KINDS = ['component', 'window', 'promise', 'chunk', 'navigation', 'api', 'pdf'] as const
export type WebDiagnosticKind = typeof KINDS[number]
export type WebFailure = 'component' | 'window' | 'promise' | 'chunk' | 'navigation' | 'pdf' | 'timeout' | 'network_or_cors' | 'unauthorized' | 'forbidden' | 'conflict' | 'server_error' | 'http_error' | 'unexpected'
export interface WebDiagnosticRecord {
  kind: WebDiagnosticKind
  failure: WebFailure
  diagnostic: DiagnosticEvent
  first_seen: number
  last_seen: number
  count: number
}

function failure(kind: WebDiagnosticKind, event: DiagnosticEvent, name: unknown): WebFailure {
  if (kind !== 'api') return kind
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(event.error_code) || name === 'TimeoutError') return 'timeout'
  if (event.status === 401) return 'unauthorized'
  if (event.status === 403) return 'forbidden'
  if (event.status === 409) return 'conflict'
  if (event.status != null && event.status >= 500) return 'server_error'
  if (event.status != null && event.status >= 400) return 'http_error'
  if (event.error_code === 'ERR_NETWORK') return 'network_or_cors'
  return 'unexpected'
}

/** Per-document memory only. The context discriminator is never part of a record. */
export function createWebDiagnosticHistory(options: { version: string; context: () => unknown; now?: () => number }) {
  const records = shallowRef<readonly WebDiagnosticRecord[]>([])
  const backendVersion = shallowRef<string>()
  const version = diagnosticEvent('diagnostic', null, { version: options.version }).version
  let context: unknown = Symbol(), token = Symbol()
  function syncContext() {
    let next: unknown
    try { next = options.context() } catch { next = Symbol() }
    if (!Object.is(context, next)) {
      context = next
      token = Symbol()
      records.value = []
      backendVersion.value = undefined
    }
    return token
  }
  function capture(kind: WebDiagnosticKind, error?: unknown, requestId?: unknown, expected = syncContext()) {
    try {
      if (expected !== syncContext() || !KINDS.includes(kind)) return
      const input = error != null && typeof error === 'object' ? error as { name?: unknown; code?: unknown } : {}
      const name = input.name
      if (name === 'AbortError' || input.code === 'ERR_CANCELED') return
      const event = diagnosticEvent(kind === 'api' ? 'http-network' : 'diagnostic', error,
        { platform: 'web', version, request_id: requestId })
      const classification = failure(kind, event, name)
      const key = (item: WebDiagnosticRecord) => JSON.stringify([item.kind, item.failure, item.diagnostic.error_code, item.diagnostic.status, item.diagnostic.version])
      const rawTime = (options.now ?? Date.now)()
      const now = Number.isSafeInteger(rawTime) && rawTime >= 0 && rawTime <= 8640000000000000 ? rawTime : 0
      const entry: WebDiagnosticRecord = { kind, failure: classification, diagnostic: event, first_seen: now, last_seen: now, count: 1 }
      const index = records.value.findIndex(item => key(item) === key(entry))
      const prior = records.value[index]
      if (prior) {
        entry.first_seen = prior.first_seen
        entry.last_seen = Math.max(prior.last_seen, now)
        entry.count = Math.min(prior.count + 1, 1000000)
      }
      if (new TextEncoder().encode(JSON.stringify(entry)).length > 2048) return
      records.value = [entry, ...records.value.filter((_, i) => i !== index)].slice(0, 50)
    } catch { /* Diagnostics must never reject a business operation. */ }
  }
  function rememberBackendVersion(value: unknown, expected = syncContext()) {
    if (expected !== syncContext()) return
    const candidate = typeof value === 'string' ? value.replace(/^v/, '') : undefined
    backendVersion.value = diagnosticEvent('diagnostic', null, { version: candidate }).version
  }
  function snapshot() {
    syncContext()
    return { schema: 1, platform: 'web', frontend_version: version ?? 'unknown', backend_version: backendVersion.value ?? 'unknown',
      records: records.value.map(item => ({ ...item, diagnostic: { ...item.diagnostic } })) }
  }
  return { records: readonly(records), backendVersion: readonly(backendVersion), capture,
    contextToken: syncContext, rememberBackendVersion, snapshot,
    report: () => JSON.stringify(snapshot(), null, 2),
    clear: () => { syncContext(); records.value = [] },
    reset: () => { syncContext(); token = Symbol(); records.value = []; backendVersion.value = undefined } }
}
