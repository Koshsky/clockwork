import { t } from '@/i18n'
import { AxiosHeaders } from 'axios'
import routes from '@/session/apiRoutes.json'
import { desktopSession, prepareDesktopSession } from '@/session/desktop'
import type { DesktopMutation } from '@/data/contracts'

export interface NativeCommand {
  operationId: string
  input: DesktopMutation
  status: 'queued' | 'unknown' | 'confirmed' | 'rejected' | 'conflict'
  dependencies?: string[]
  http: { tempId: number | null; createdAt: number; error?: { message: string }; discarded: boolean }
}
export interface DesktopQueue {
  request<T = unknown>(request: Record<string, unknown>): Promise<T>
}
export function desktopQueueMessage(code: string): string {
  const keys: Record<string, string> = {
    COMMAND_BASELINE_REQUIRED: 'offline.queue.baselineRequired', COMMAND_BASELINE_AMBIGUOUS: 'offline.queue.baselineAmbiguous',
    COMMAND_DURABLE_UNSUPPORTED: 'offline.queue.incompatibleServer', COMMAND_RECEIPT_MISMATCH: 'offline.queue.receiptMismatch',
    COMMAND_RATE_LIMIT: 'offline.queue.rateLimited', COMMAND_RESPONSE_UNKNOWN: 'offline.queue.unknownOutcome',
    COMMAND_RETRY_PENDING: 'offline.queue.unknownOutcome', COMMAND_OUTCOME_UNKNOWN: 'offline.queue.unknownOutcome',
    STORAGE_OUTCOME_UNKNOWN: 'offline.queue.unknownOutcome', STORAGE_DEPENDENTS_EXIST: 'offline.queue.dependentsExist',
  }
  return t(keys[code] || 'offline.queue.storageUnavailable')
}
export const nativeQueue = typeof window !== 'undefined' ? window.erpDesktop?.queue : undefined
export async function queueRequest<T>(request: Record<string, unknown>): Promise<T> {
  if (!nativeQueue) throw new Error('COMMAND_UNAVAILABLE')
  const own = await prepareDesktopSession()
  if (request.contextId != null && request.contextId !== own.contextId) throw new Error('SESSION_CONTEXT_CHANGED')
  let value: T
  try { value = await nativeQueue.request<T>({ ...request, contextId: own.contextId }) }
  catch (error) {
    if ((await desktopSession!.status()).contextId !== own.contextId) throw new Error('SESSION_CONTEXT_CHANGED')
    const message = error instanceof Error ? error.message : ''
    throw /^STORAGE_|^COMMAND_/.test(message) ? new Error(desktopQueueMessage(message)) : error
  }
  if ((await desktopSession!.status()).contextId !== own.contextId) throw new Error('SESSION_CONTEXT_CHANGED')
  return value
}
export async function nativeCommands(): Promise<NativeCommand[]> {
  const rows: NativeCommand[] = []
  const contextId = (await prepareDesktopSession()).contextId
  let after = 0
  for (;;) {
    const page = await queueRequest<{ items: NativeCommand[]; after: number; complete: boolean }>({ action: 'list', after, contextId })
    rows.push(...page.items)
    if (page.complete) return rows
    if (!Number.isSafeInteger(page.after) || page.after <= after) throw new Error('COMMAND_INVALID_PAGE')
    after = page.after
  }
}
export function nativeEntry(row: NativeCommand) {
  const input = row.input, route = routes.find(route => route.operation === input.route)!
  let path = route.path
  for (const [key, value] of Object.entries(input.path || {})) path = path.replace('{' + key + '}', String(value))
  const query = new URLSearchParams(input.query)
  const entity = path.includes('/members') ? 'member' : path.includes('/days') ? 'period' : path.includes('/dependencies') ? 'task'
    : path.includes('/order') ? 'reorder' : path.startsWith('/timesheet/states') ? 'state'
      : path.startsWith('/resources') ? 'resource' : path.split('/')[1]!
  return {
    id: row.operationId, ts: row.http.createdAt, method: route.method,
    url: '/api/v1' + path + (query.size ? '?' + query : ''), body: input.body,
    entity, tempId: input.tempId, idempotencyKey: row.operationId,
    ...(row.status === 'rejected' || row.status === 'conflict' || row.http.error ? { failed: { at: row.http.createdAt, message: row.http.error?.message?.startsWith('COMMAND_') ? desktopQueueMessage(row.http.error.message) : row.http.error?.message || t(row.status === 'conflict' ? 'offline.queue.conflict' : 'offline.queue.rejected') }, quarantined: row.status === 'rejected' || row.status === 'conflict' } : {}),
  }
}
export async function enqueueNative(entry: { method: string; url: string; body?: unknown; tempId?: number; idempotencyKey?: string }) {
  const state = await prepareDesktopSession(), url = new URL(entry.url, state.server || 'http://invalid'), base = new URL(state.server!)
  if (url.origin !== base.origin) throw new Error('COMMAND_INVALID_SERVER')
  const relative = url.pathname.slice(base.pathname.length)
  let path: Record<string, string> = {}
  const route = routes.find(item => {
    if (item.method !== entry.method.toUpperCase()) return false
    const names = [...item.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!)
    const match = new RegExp('^' + item.path.replace(/\{[^}]+\}/g, '(-?[1-9]\\d*)') + '$').exec(relative)
    if (!match) return false
    path = Object.fromEntries(names.map((name, index) => [name, match[index + 1]!]))
    return true
  })
  if (!route) throw new Error('COMMAND_INVALID_REQUEST')
  const preconditions = (await import('@/store/data/nativeBaselines')).capture({ route: route.operation, path, query: Object.fromEntries(url.searchParams), body: entry.body })
  return queueRequest({ action: 'enqueue', operationId: entry.idempotencyKey || crypto.randomUUID(), input: { route: route.operation, path, query: Object.fromEntries(url.searchParams), body: entry.body, tempId: entry.tempId, preconditions } })
}
export function queuedResponse(response: unknown): boolean {
  return AxiosHeaders.from((response as { headers?: Record<string, string> })?.headers).get('Operation-Status') === 'queued'
}

export function nativeDiscardPlan(rows: ReadonlyArray<Pick<NativeCommand, 'operationId' | 'status' | 'dependencies'>>): string[] {
  const selected = new Set(rows.filter(row => row.status === 'rejected' || row.status === 'conflict').map(row => row.operationId))
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (!selected.has(row.operationId) && row.dependencies?.some(id => selected.has(id))) { selected.add(row.operationId); changed = true }
  }
  return [...selected]
}
