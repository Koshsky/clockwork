import { desktopSession, desktopSessionState } from '@/session/desktop'
import { ref, watch } from 'vue'
import axios, { type AxiosError, type AxiosRequestConfig, type Method } from 'axios'
import { idbAll, idbCount, idbDel, idbPut, IDMAP_STORE_NAME, type IdMapEntry } from './db'
import { applyToCache } from './cacheApply'
import { probeBackend } from './state'
import { getApiUrl } from '@/config'
import { getAccessToken } from '../token'
import { isLoggedOut } from '../loggedOut'
import { appLocale, t } from '../i18n'
import { legacyQueueAvailability } from '@/platform/state'
import { platformCapabilities } from '@/platform/context'

/**
 * Mutation queue (outbox pattern): create/update/delete requests made
 * while offline are stored in IndexedDB and sent to the backend when the
 * network returns (see sync.ts). The view is already updated optimistically
 * (UI in the store), while the raw request is kept here for replay.
 *
 * FIFO: entries are executed strictly in order — later edits/deletes of
 * entities created offline depend on previous ones.
 *
 * STORAGE: the queue is stored indefinitely — it has no TTL and is never
 * swept by age/timers. Entries are removed only after a successful send, on a
 * verified login of a different account (pruneForeignOutbox — the previous
 * account is logged out, so the flush-time creator guard would park its entries
 * forever), or by explicit user actions (discardFailed / discardEntry).
 * Logout itself does NOT wipe the queue: a sibling tab of the
 * same user may still have pending edits (H-OFF-3). Backoff and quarantined
 * flags only gate auto-retries; they never delete an entry.
 * See docs/no-ttl-local-storage.md.
 */

const OUTBOX_STORE = 'outbox'
/** How long to wait before retrying an entry rejected by the server */
const FAILED_BACKOFF_MS = 60 * 1000
/** After how many server errors an entry goes to quarantine (no auto-retries) */
const MAX_FAILED_ATTEMPTS = 5
/** Outbox send rate (entries/sec) — to avoid hammering the server with a batch */
const SYNC_RATE_PER_SECOND = 10
const PAUSE_MS = 1000 / SYNC_RATE_PER_SECOND

export type MutationEntity =
  | 'resource'
  | 'user'
  | 'member'
  | 'state'
  | 'period'
  | 'project'
  | 'process'
  | 'task'
  | 'milestone'
  | 'assignment'
  | 'reorder'

export interface OutboxEntry {
  /** Survives a lost initial response; legacy entries use their queue id. */
  idempotencyKey?: string
  id: string
  /** Send order (FIFO) */
  ts: number
  method: Method
  /** Full absolute URL of the request (including query parameters) */
  url: string
  body?: unknown
  entity: MutationEntity
  /** Temporary (negative) id for entities created offline */
  tempId?: number
  /** Account (username) under which the entry was created (guard against autosync under a foreign token) */
  creator?: string
  failed?: { message: string; at: number }
  /** How many times the server answered with an error (for quarantine) */
  attempts?: number
  /** The server consistently rejects the entry — auto-retries are stopped */
  quarantined?: boolean
}

/** An entry that could not be sent (for UI: list of sync errors) */
export interface FailedSyncItem {
  method: Method
  url: string
  message: string
}

export const OUTBOX_STORE_NAME = OUTBOX_STORE

/** Number of changes awaiting sync (reactive for UI). Quarantined ones are not counted. */
export const pendingCount = ref(0)

/**
 * Reactive set of objects that have at least one unsent mutation in the queue —
 * keys are `${entity}:${id}` (id from the URL or the temporary id for creates).
 * Used by lists (composables/usePendingMark) to show the "awaiting sync" clock
 * mark next to the affected rows. Includes quarantined entries — their change
 * has not reached the server either.
 */
export const pendingRefs = ref<Set<string>>(new Set())

/** Live queue push progress (for UI): { done, total } or null when not running */
export const pushProgress = ref<{ done: number; total: number } | null>(null)

/**
 * Human-readable representation of a queue entry for UI ("Change queue"
 * on the sync screen): which object, which operation and key fields.
 */
export interface QueueViewItem {
  id: string
  /** Send order (FIFO) */
  ts: number
  entity: MutationEntity
  entityLabel: string
  operation: 'create' | 'update' | 'delete'
  operationLabel: string
  /** Target id from the URL (or temporary id for entries created offline) */
  targetId?: number
  /** Short caption of the changed object (title/name/code/dates) */
  summary: string
  /** Key fields from the request body (for display) */
  details: Array<{ key: string; value: string }>
  /** Technical entry data for inspection (on click): method/url/body */
  method: string
  url: string
  body?: unknown
  tempId?: number
  /** The entry failed to send (has an error) but remains in the queue */
  error?: boolean
  message?: string
}

/** Catalog keys of the entity names shown in the queue. */
const ENTITY_KEYS: Record<MutationEntity, string> = {
  resource: 'offline.entity.resource',
  user: 'offline.entity.user',
  member: 'offline.entity.member',
  state: 'offline.entity.state',
  period: 'offline.entity.period',
  project: 'offline.entity.project',
  process: 'offline.entity.process',
  task: 'offline.entity.task',
  milestone: 'offline.entity.milestone',
  assignment: 'offline.entity.assignment',
  reorder: 'offline.entity.reorder',
}

/** Entity name in the active language (resolved at call time). */
export function entityLabel(entity: MutationEntity): string {
  const key = ENTITY_KEYS[entity]
  return key ? t(key) : entity
}

export function operationLabel(method: string): string {
  switch ((method || '').toUpperCase()) {
    case 'POST':
      return t('offline.operation.create')
    case 'PUT':
    case 'PATCH':
      return t('offline.operation.update')
    case 'DELETE':
      return t('offline.operation.delete')
    default:
      return (method || '').toUpperCase()
  }
}

function operationOf(method: string): QueueViewItem['operation'] {
  switch ((method || '').toUpperCase()) {
    case 'POST':
      return 'create'
    case 'PUT':
    case 'PATCH':
      return 'update'
    case 'DELETE':
      return 'delete'
    default:
      return 'update'
  }
}

function firstString(body: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!body) return undefined
  for (const k of keys) {
    const v = body[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

/** Short caption of the changed object: title/code (no id — id is shown separately) */
function summarizeEntry(entry: OutboxEntry): string {
  const body = (entry.body ?? {}) as Record<string, unknown>
  return firstString(body, ['title', 'name', 'code', 'username', 'last_name']) ?? ''
}

/** Catalog keys of the key fields shown in entry details. */
const FIELD_KEYS: Record<string, string> = {
  code: 'offline.field.code',
  title: 'offline.field.title',
  name: 'offline.field.name',
  last_name: 'offline.field.lastName',
  first_name: 'offline.field.firstName',
  middle_name: 'offline.field.middleName',
  username: 'offline.field.username',
  position: 'offline.field.position',
  preset: 'offline.field.preset',
  priority: 'offline.field.priority',
  start_date: 'offline.field.startDate',
  end_date: 'offline.field.endDate',
  date: 'offline.field.date',
  owner_id: 'offline.field.ownerId',
  project_id: 'offline.field.projectId',
  process_id: 'offline.field.processId',
  task_id: 'offline.field.taskId',
  resource_id: 'offline.field.resourceId',
  user_id: 'offline.field.userId',
  state_id: 'offline.field.stateId',
  quantity: 'offline.field.quantity',
}

/** Field label in the active language (an unknown field keeps its raw name). */
function fieldLabel(key: string): string {
  const catalogKey = FIELD_KEYS[key]
  return catalogKey ? t(catalogKey) : key
}

/** Formats one field into a "label → value" pair (for details and comparison). */
function formatField(k: string, v: unknown): { key: string; value: string } {
  const value = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return { key: fieldLabel(k), value }
}

/** Fields from a Record into {key,value} pairs, excluding empty/null values. */
function fieldsOf(obj: Record<string, unknown> | undefined): Array<{ key: string; value: string }> {
  if (!obj) return []
  const out: Array<{ key: string; value: string }> = []
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue
    out.push(formatField(k, v))
  }
  return out
}

/** Only the key fields from the request body — for compact display */
function detailsOf(entry: OutboxEntry): Array<{ key: string; value: string }> {
  const body = (entry.body ?? {}) as Record<string, unknown>
  const out = fieldsOf(body)
  // Timesheet period: DELETE carries the range in query parameters, not in the body.
  if (entry.entity === 'period' && Object.keys(body).length === 0) {
    try {
      const u = new URL(entry.url, 'https://mvs.local')
      const start = u.searchParams.get('start_date')
      const end = u.searchParams.get('end_date')
      const state = u.searchParams.get('state_id')
      if (start) out.push({ key: t('offline.field.startDate'), value: start })
      if (end) out.push({ key: t('offline.field.endDate'), value: end })
      if (state) out.push({ key: t('offline.field.stateId'), value: state })
    } catch {
      // invalid URL — skip the query data
    }
  }
  return out
}

/** Target id from the last URL segment (PUT/DELETE /entity/{id}), otherwise — temporary id */
function entryIdOf(entry: OutboxEntry): number | undefined {
  if (entry.tempId != null) return entry.tempId
  try {
    const p = new URL(entry.url, 'https://mvs.local').pathname.replace(/\/+$/, '')
    const seg = p.split('/').pop() ?? ''
    const n = Number(seg)
    return Number.isFinite(n) ? n : undefined
  } catch {
    return undefined
  }
}

function toViewItem(entry: OutboxEntry): QueueViewItem {
  return {
    id: entry.id,
    ts: entry.ts,
    entity: entry.entity,
    entityLabel: entityLabel(entry.entity),
    operation: operationOf(entry.method),
    operationLabel: operationLabel(entry.method),
    targetId: entryIdOf(entry),
    summary: summarizeEntry(entry),
    details: detailsOf(entry),
    method: (entry.method || '').toUpperCase(),
    url: entry.url,
    body: entry.body,
    tempId: entry.tempId,
    error: entry.failed != null,
    message: entry.failed?.message ?? '',
  }
}

/** Reactive list of changes awaiting send (for the sync screen) */
export const queueItems = ref<QueueViewItem[]>([])

/**
 * The queue view model is materialized into a ref with already-resolved
 * labels, so it is rebuilt when the interface language changes.
 */
watch(appLocale, () => {
  void refreshQueue()
})

/** Re-reads the queue into queueItems. Only unsent and non-synced
 *  entries (!quarantined), in send order (FIFO). Quarantined ones are visible in the errors block. */
export async function refreshQueue(): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => null)
  if (!entries) { legacyQueueAvailability.value = 'unavailable'; return }
  queueItems.value = entries
    .filter((e) => !e.quarantined)
    .sort((a, b) => a.ts - b.ts)
    .map(toViewItem)
}

export async function refreshPendingCount(): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => null)
  if (!entries) { legacyQueueAvailability.value = 'unavailable'; return }
  pendingCount.value = entries.filter((e) => !e.quarantined).length
  // Rebuild the "awaiting sync" mark set from all queued entries (quarantined
  // included — they still wait for a manual retry). Entries without a resolvable
  // target id (e.g. a bare POST with no temporary id) produce no mark.
  const refs = new Set<string>()
  for (const e of entries) {
    const id = entryIdOf(e)
    if (id != null) refs.add(`${e.entity}:${id}`)
  }
  pendingRefs.value = refs
  legacyQueueAvailability.value = entries.length > 0 ? 'pending' : 'empty'
  await refreshQueue()
}

export function createMutationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** axios serializes config.data (transformRequest) — normalize to an object */
function normalizeBody(body: unknown): unknown {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  return body
}

export async function enqueueMutation(
  entry: Omit<OutboxEntry, 'id' | 'ts' | 'failed'>,
): Promise<void> {
  if (platformCapabilities.kind === 'web') throw new Error('WEB_OFFLINE_QUEUE_UNAVAILABLE')
  const rec: OutboxEntry = { ...entry, body: normalizeBody(entry.body), id: createMutationKey(), ts: Date.now(), creator: currentUsername() ?? undefined }
  // Deduplication: a repeated click on the same mutation (method+url+body) does not
  // spawn identical entries — the queue stays clean and flush does not send duplicate batches.
  const bodyKey = rec.body != null ? JSON.stringify(rec.body) : ''
  const existing = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => [] as OutboxEntry[])
  const dup = existing.some(
    (e) =>
      (rec.idempotencyKey != null ? e.idempotencyKey === rec.idempotencyKey : e.idempotencyKey == null) &&
      e.method === rec.method &&
      e.url === rec.url &&
      (e.body != null ? JSON.stringify(e.body) : '') === bodyKey,
  )
  if (dup) return
  rec.ts = existing.reduce((latest, entry) => Math.max(latest, entry.ts + 1), rec.ts)
  await idbPut(OUTBOX_STORE, rec.id, rec)
  await refreshPendingCount()
  // Write-through: apply the delta to "warmed" data (cache of GET responses)
  // so that offline changes do not disappear after a page reload.
  await applyToCache(rec)
}

/** Replaces temporary ids with real ones (after successful creates in the queue) */
function rewriteUrlIds(input: string, idMap: Map<number, number>): string {
  const url = new URL(input, 'http://relative.invalid')
  const mapped = (value: string) => /^-\d+$/.test(value) ? String(idMap.get(Number(value)) ?? value) : value
  url.pathname = url.pathname.replace(/(?<=\/)-\d+(?=\/|$)/g, mapped)
  for (const [key, value] of url.searchParams) {
    const replacement = value.split(',').map(mapped).join(',')
    if (replacement !== value) url.searchParams.set(key, replacement)
  }
  return input.startsWith('/') ? url.pathname + url.search + url.hash : url.toString()
}

function rewriteBodyIds(value: unknown, idMap: Map<number, number>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteBodyIds(item, idMap))
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteBodyIds(item, idMap)]))
  }
  return typeof value === 'number' ? idMap.get(value) ?? value : value
}

/**
 * Rebases a stored queue URL onto the CURRENT API address.
 * The URL in an entry is fixed at mutation creation time and may become stale
 * (server changed, or API_URL was changed to simulate an outage). We replace only the
 * origin (scheme+host); path and query are kept — so a stale/broken host
 * (e.g. localhosat) no longer breaks sending: the entry goes out to the current address.
 */
function rebasedUrl(url: string): string {
  const current = getApiUrl()
  try {
    const u = new URL(url, current ?? 'http://localhost')
    if (current) {
      const base = new URL(current)
      u.protocol = base.protocol
      u.host = base.host
    }
    return u.toString()
  } catch {
    return url
  }
}

function isNetworkError(e: unknown): boolean {
  const err = e as AxiosError
  return Boolean(err && !err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error'))
}

export { isNetworkError }

/**
 * Server sentinel messages without details → human-readable Russian text.
 * When the backend sends a detailed message (e.g. "resource does not
 * belong to the task owner") it is shown as is.
 */
const GENERIC_SERVER_MESSAGE_KEYS: Record<string, string> = {
  forbidden: 'offline.server.forbidden',
  unauthorized: 'offline.server.unauthorized',
  'not found': 'offline.server.notFound',
  'bad request': 'offline.server.badRequest',
  conflict: 'offline.server.conflict',
  'validation failed': 'offline.server.validation',
}

function errorMessage(e: unknown): string {
  const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string }
  const server = err?.response?.data?.error?.message
  const genericKey = server ? GENERIC_SERVER_MESSAGE_KEYS[server] : undefined
  if (genericKey) return t(genericKey)
  return server ?? err?.message ?? String(e)
}

export { errorMessage }

/** Name of the current user from the saved profile. Straight from localStorage,
 *  without importing the store (otherwise a store ↔ outbox cycle). */
function currentUsername(): string | null {
  if (desktopSession) {
    const state = desktopSessionState.value
    return state?.mode !== 'signedOut' ? state?.user?.username ?? null : null
  }
  try {
    const raw = localStorage.getItem('mvs_erp_user')
    if (!raw) return null
    const u = JSON.parse(raw) as { username?: string }
    return u.username ?? null
  } catch {
    return null
  }
}

/**
 * Deterministic client errors (4xx except 409/429): retrying won't fix them
 * (no permissions, invalid data) — quarantine immediately. 429 — "slow down"; 409 —
 * "in-flight"/idempotency business conflict: the first call may still be
 * running (a retry gets the saved response) — both stay on
 * backoff retries and go to quarantine after MAX_FAILED_ATTEMPTS.
 */
function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 409 && status !== 429
}

/** Marker "references a not-yet-created object": the URL/body has a negative
 *  (temporary, offline) id — the entry waits for the creator entry to sync. */
function referencesPendingCreation(url: string, body: unknown): boolean {
  const text = `${url} ${typeof body === 'string' ? body : JSON.stringify(body ?? '')}`
  return /-\d{6,}/.test(text)
}

/** Extracts the real id of the created entity from the payload { data, error }.
 *  For most entities the id is at the top level (data.id), but for user creation
 *  it is in the nested data.user (DtoCreateUserResult = { user, password }).
 *  Without this the tempId→realId mapping is not created and dependent entries (e.g.
 *  PUT /user/{tempId}/days) go out with a fake id → 404. */
function createdIdOf(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined
  const obj = data as Record<string, unknown>
  if (typeof obj.id === 'number') return obj.id
  const nested = obj.user
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).id === 'number') {
    return (nested as Record<string, unknown>).id as number
  }
  return undefined
}

/** Idempotency-Key is sent on mutating methods (not GET): the entry id — a stable
 *  UUID across queue retries — makes the server return the saved response instead of
 *  re-executing when the first call's response was lost. */
function needsIdempotencyKey(method: Method): boolean {
  return (method || 'get').toUpperCase() !== 'GET'
}

/** Logs a queue entry send error in detail (for diagnostics). */
function logOutboxError(entry: OutboxEntry, url: string, e: unknown): void {
  const err = e as AxiosError & { code?: string; timeout?: number }
  const base = {
    method: (entry.method || '').toUpperCase(),
    url,
    body: entry.body,
    tempId: entry.tempId,
    entity: entry.entity,
    message: errorMessage(e),
  }
  const detail = err.response
    ? { kind: 'http', status: err.response.status, statusText: err.response.statusText }
    : {
        kind: 'network',
        code: err.code,
        timeout_ms: err.timeout,
        message: err.message,
      }
  // i18n-allow: developer console diagnostics, never rendered in the UI
  console.error('[outbox] failed to send entry:', base, detail, {
    config: err.config ? { method: err.config.method, url: err.config.url, data: err.config.data } : undefined,
  })
}

/**
 * Real backend availability check. navigator.onLine lies (on "dead"
 * WiFi it is true), so before sending the queue we ping the real
 * /api/v1/health endpoint. Any HTTP status (<500) = reachable; the network is
 * unavailable only on a network error/timeout.
 */
async function isServerReachable(): Promise<boolean> {
  return probeBackend()
}

export interface FlushResult {
  ok: number
  failed: number
  /** The queue was not fully sent (the network dropped again) */
  interrupted: boolean
  /** Domains touched by sent/failed entries (for reconcile) */
  entities: Set<MutationEntity>
  /** Details of unsent entries (for UI) */
  failedEntries: FailedSyncItem[]
}

let flushing = false

/** Pause between queue entry sends (rate limit) */
function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
}

/**
 * Sends the queue to the backend. One run at a time; when the network
 * returns again, the remaining entries go out with the next flush.
 */
function emptyFlush(): FlushResult {
  return { ok: 0, failed: 0, interrupted: false, entities: new Set<MutationEntity>(), failedEntries: [] }
}

export async function flushOutbox(): Promise<FlushResult> {
  if (platformCapabilities.kind === 'web') return emptyFlush()
  if (typeof navigator !== 'undefined' && navigator.locks) {
    // Never queue behind a suspended tab: the next minute cycle retries ownership.
    return navigator.locks.request('mvs_erp_outbox', { ifAvailable: true }, lock => lock ? flushOwnedOutbox() : emptyFlush())
  }
  return flushOwnedOutbox()
}

async function flushOwnedOutbox(): Promise<FlushResult> {
  const empty = emptyFlush
  if (flushing) return empty()
  flushing = true
  const result: FlushResult = { ok: 0, failed: 0, interrupted: false, entities: new Set(), failedEntries: [] }
  try {
    // Server unreachable (dead WiFi, no internet) — leave the queue alone:
    // quiet skip, no reconcile, no loss/corruption of entries.
    if (!(await isServerReachable())) {
      return empty()
    }

    const entries = (await idbAll<OutboxEntry>(OUTBOX_STORE)).sort((a, b) => a.ts - b.ts)
    // Persistent tempId → realId mapping: accumulated by previous runs
    // (interrupted flush, repeated starts). Without it, entries referencing
    // already-sent creates would go out with a fake id → 404 "Object not found".
    const persisted = await idbAll<IdMapEntry>(IDMAP_STORE_NAME).catch(() => [] as IdMapEntry[])
    const idMap = new Map<number, number>(persisted.map((e) => [e.temp, e.real]))
    pushProgress.value = { done: 0, total: entries.length }
    let done = 0

    for (const entry of entries) {
      if (isLoggedOut()) {
        result.interrupted = true
        break
      }
      // Quarantine and backoff: don't touch entries the server just rejected.
      if (entry.quarantined) continue
      if (entry.failed && Date.now() - entry.failed.at < FAILED_BACKOFF_MS) continue

      result.entities.add(entry.entity)

      // The queue is tied to the creator account: don't send edits made under
      // another user (autologin may have switched accounts) — the server would
      // reject them by RBAC and the edit would remain "stuck".
      const sender = currentUsername()
      if (entry.creator && sender && entry.creator !== sender) {
        const message = t('offline.queue.foreignCreator', { creator: entry.creator, sender })
        await idbPut(OUTBOX_STORE, entry.id, { ...entry, quarantined: true, failed: { message, at: Date.now() } })
        result.failed++
        result.failedEntries.push({ method: entry.method, url: entry.url, message })
        await pause()
        continue
      }

      const url = rewriteUrlIds(rebasedUrl(entry.url), idMap)
      const body = entry.body != null ? JSON.stringify(rewriteBodyIds(entry.body, idMap)) : undefined
      try {
        const token = getAccessToken()
        const res = await axios({
          method: entry.method,
          url,
          data: body != null ? (JSON.parse(body) as unknown) : undefined,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(needsIdempotencyKey(entry.method) ? { 'Idempotency-Key': entry.idempotencyKey ?? entry.id } : {}),
          },
          timeout: 15000,
          // The sync toast (SyncToast) is the feedback channel for queued
          // mutations: the global error toast must not fire a duplicate.
          silentError: true,
        } as AxiosRequestConfig & { silentError: boolean })

        // The create returned a real entity → remember temp→real for later
        // queue entry rewrites. The mapping is written to IndexedDB BEFORE the
        // creator entry is deleted: even if flush breaks right after,
        // the next run rewrites dependent entries with the real id.
        if (entry.tempId != null) {
          const created = createdIdOf(res.data?.data)
          if (created != null) {
            idMap.set(entry.tempId, created)
            await idbPut(IDMAP_STORE_NAME, String(entry.tempId), { temp: entry.tempId, real: created } satisfies IdMapEntry)
          }
        }

        await idbDel(OUTBOX_STORE, entry.id)
        result.ok++
      } catch (e) {
        const err = e as AxiosError
        // Error without an HTTP response (ERR_NETWORK, timeout, abort). This is not
        // always a network drop: the health probe passed before sending, so the
        // server could be alive while a specific request "disappeared" (timeout/one-off failure).
        if (!err.response) {
          // Re-check backend health: if it is unreachable again — this is a
          // real drop, interrupt the rest of the queue.
          if (!(await isServerReachable())) {
            result.interrupted = true
            break
          }
          // Backend is alive: one-off error of a single entry. Mark it failed
          // (stays in the queue) and keep sending the rest — one failed
          // entry must not break the whole sync.
          logOutboxError(entry, url, e)
          const attempts = (entry.attempts ?? 0) + 1
          const quarantined = attempts >= MAX_FAILED_ATTEMPTS
          const message = errorMessage(e) || t('offline.queue.noResponse')
          await idbPut(OUTBOX_STORE, entry.id, {
            ...entry,
            attempts,
            quarantined,
            failed: { message, at: Date.now() },
          })
          result.failed++
          result.failedEntries.push({ method: entry.method, url, message })
        } else {
          // DELETE of a non-existent entity (404/410) — it is already gone, the target
          // state is reached. Idempotent drop instead of endless retries.
          // Tradeoff (kept by design): a 404 caused by a WRONG URL path (rebasedUrl
          // only swaps the origin, so a path mistake still 404s) is also dropped
          // silently — but DELETE is idempotent, retrying cannot fix the URL, and
          // keeping the entry would just quarantine it. The temp-id case (a DELETE
          // referencing a not-yet-created object) is covered by queue ordering: the
          // flush sorts entries by enqueue time, so the creator entry goes out first
          // and rewriteIds substitutes the real id before this DELETE is sent.
          const status = err.response.status
          // Session renewal can fail independently of the saved mutation.
          if (status === 401) {
            result.interrupted = true
            break
          }
          const method = (entry.method || '').toUpperCase()
          if (method === 'DELETE' && (status === 404 || status === 410)) {
            await idbDel(OUTBOX_STORE, entry.id)
            result.ok++
          } else {
            // The server actually responded (400/403/409/422/500...) — a real error.
            // Deterministic 4xx (except 429) go to quarantine right away — retrying
            // won't fix; 5xx — count attempts with backoff.
            logOutboxError(entry, url, e)
            const attempts = (entry.attempts ?? 0) + 1
            // The entry references a not-yet-synced object (a negative temporary id in
            // URL/body — e.g. PUT /user/{tempId}/days before the employee is created).
            // Such a 404 is not fatal: the creator will go out with the next
            // flush (or after "Retry"), so we don't quarantine it and keep it
            // on backoff retries.
            const waitsForCreator = referencesPendingCreation(url, body ?? '')
            const quarantined = !waitsForCreator && (isPermanentFailure(status) || attempts >= MAX_FAILED_ATTEMPTS)
            const message =
              waitsForCreator && status === 404
                ? t('offline.queue.pendingCreation')
                : errorMessage(e)
            await idbPut(OUTBOX_STORE, entry.id, {
              ...entry,
              attempts,
              quarantined,
              failed: { message, at: Date.now() },
            })
            result.failed++
            result.failedEntries.push({ method: entry.method, url, message })
          }
        }
      }
      // Rate limit: pause between actual sends so we don't blast a batch
      // of requests (warmup and the queue must not bring the server to its knees).
      await pause()
      done++
      pushProgress.value = { done, total: entries.length }
    }
  } finally {
    flushing = false
    pushProgress.value = null
    await refreshPendingCount()
    // Keep temp-id mappings: another tab may still enqueue an edit of a completed create.
    // Explicit queue clearing and account cleanup own their removal.
  }
  return result
}

/** Clears the queue (the explicit "clear all" action in the sync UI / reset) */
export async function clearOutbox(): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE)
  await Promise.all(entries.map((e) => idbDel(OUTBOX_STORE, e.id)))
  // Along with the queue, reset the mappings: negative ids of a new session must
  // not accidentally be replaced with old correspondences.
  const maps = await idbAll<IdMapEntry>(IDMAP_STORE_NAME).catch(() => [] as IdMapEntry[])
  await Promise.all(maps.map((m) => idbDel(IDMAP_STORE_NAME, String(m.temp))))
  await refreshPendingCount()
}

/**
 * Deletes queue entries created under another account — called after a verified
 * online login: the previous account is logged out (its session revoked), so
 * the flush-time creator guard would otherwise park those entries forever with
 * a "created under account X" error. Same-account entries (e.g. pending work of
 * a sibling tab of the same user) are kept — the wipe-on-logout that used to
 * delete them is gone (H-OFF-3). idmap rows are removed only when their temp id
 * is no longer referenced by any remaining entry.
 */
export async function pruneForeignOutbox(keepCreator: string): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => [] as OutboxEntry[])
  const kept: OutboxEntry[] = []
  const removed: OutboxEntry[] = []
  for (const e of entries) {
    if (e.creator && e.creator !== keepCreator) removed.push(e)
    else kept.push(e)
  }
  if (removed.length) {
    await Promise.all(removed.map((e) => idbDel(OUTBOX_STORE, e.id)))
    // Drop mappings whose temp id is not referenced by the kept queue.
    const keptText = kept.map((e) => `${e.url} ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '')}`).join(' ')
    const maps = await idbAll<IdMapEntry>(IDMAP_STORE_NAME).catch(() => [] as IdMapEntry[])
    await Promise.all(
      maps.filter((m) => !keptText.includes(String(m.temp))).map((m) => idbDel(IDMAP_STORE_NAME, String(m.temp))),
    )
  }
  await refreshPendingCount()
}

/** Entries rejected by the server (for the UI sync errors list) */
export async function getFailedEntries(): Promise<
  Array<OutboxEntry & { message: string }>
> {
  if (platformCapabilities.kind === 'web') return []
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => [] as OutboxEntry[])
  return entries
    .filter((e) => e.quarantined || e.failed)
    .map((e) => ({ ...e, message: e.failed?.message ?? '' }))
}

/** Lifts quarantine/failed flag so entries are sent again (the "Retry" button) */
export async function resetFailedRetries(): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => [] as OutboxEntry[])
  await Promise.all(
    entries
      .filter((e) => e.quarantined || e.failed)
      .map((e) =>
        idbPut(OUTBOX_STORE, e.id, { ...e, quarantined: false, attempts: 0, failed: undefined }),
      ),
  )
  await refreshPendingCount()
}

/** Removes one rejected entry from the queue */
export async function discardEntry(id: string): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  await idbDel(OUTBOX_STORE, id)
  await refreshPendingCount()
}

/** Removes all rejected entries (the "Skip" button — the user accepted the loss) */
export async function discardFailed(): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const entries = await idbAll<OutboxEntry>(OUTBOX_STORE).catch(() => [] as OutboxEntry[])
  await Promise.all(
    entries.filter((e) => e.quarantined || e.failed).map((e) => idbDel(OUTBOX_STORE, e.id)),
  )
  await refreshPendingCount()
}

/**
 * Applies ALL unsynced queue entries to the GET-response cache
 * (write-through overlay). Idempotent: DELETE/overwrites are safe to repeat,
 * POST does not duplicate by id. Called:
 *  - at app startup (before data load) — an offline reload sees the
 *    unsynced changes;
 *  - after each fresh successful GET write (http.ts) — so warmup/reconcile
 *    do not erase deltas with server truth.
 *
 * Hot-path optimizations (http.ts calls this after EVERY successful GET):
 *  - Fast exit when the queue is empty — the common case online — so a GET
 *    costs only one cheap IndexedDB count() instead of a full queue + cache
 *    scan (idbAll + applyToCache per entry).
 *  - Concurrent callers (parallel GET responses, or a GET racing startup
 *    initOfflineSync) share a single in-flight replay instead of each
 *    re-scanning; awaiters join the same promise, so "replay before cache
 *    read" (hydrateFromCache) still holds even when a replay is already
 *    running — they wait for the same completion.
 */
let replayInFlight: Promise<void> | null = null
let replayAccount: string | null = null

export async function replayOutboxToCache(): Promise<void> {
  if (platformCapabilities.kind === 'web') return
  const account = currentUsername()
  if ((await idbCount(OUTBOX_STORE)) === 0) return
  if (account !== currentUsername()) return
  if (replayInFlight) {
    if (replayAccount === account) return replayInFlight
    await replayInFlight
    if (account === currentUsername()) return replayOutboxToCache()
    return
  }
  replayAccount = account
  replayInFlight = (async () => {
    try {
      const entries = await idbAll<OutboxEntry>(OUTBOX_STORE)
      for (const entry of entries.sort((a, b) => a.ts - b.ts)) {
        if (account !== currentUsername()) break
        if (entry.creator && entry.creator !== account) continue
        await applyToCache(entry)
      }
    } finally {
      replayInFlight = null
    }
  })()
  return replayInFlight
}

/**
 * Coalesced variant for the http.ts GET hot path: a burst of parallel
 * successful GETs schedules AT MOST ONE replay per microtask tick/event-loop
 * turn instead of one per response. The replay itself still applies the whole
 * queue (the last write wins on the shared cache entries), so firing it once
 * after the burst is equivalent to firing it after each response.
 *
 * Callers that must observe the overlay before reading the cache
 * (hydrateFromCache, initOfflineSync) keep using the awaited
 * replayOutboxToCache() — this variant is only for "fire and forget after a
 * fresh write".
 */
let replayScheduled = false

export function scheduleReplayOutboxToCache(): void {
  if (platformCapabilities.kind === 'web') return
  if (replayScheduled) return
  replayScheduled = true
  void Promise.resolve().then(async () => {
    replayScheduled = false
    await replayOutboxToCache()
  }).catch(() => {
    // A background overlay cannot reject into the UI or acknowledge a lost
    // queue. Keep its entries and references for an explicit recovery attempt.
    legacyQueueAvailability.value = 'unavailable'
  })
}
