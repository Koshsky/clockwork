import { ref } from 'vue'
import { t } from '@/i18n'
import type { AxiosError } from 'axios'
import type * as Legacy from '@/offline/outbox'
export type { MutationEntity, OutboxEntry, FailedSyncItem, QueueViewItem, FlushResult } from '@/offline/outbox'

export const OUTBOX_STORE_NAME = 'outbox'
export const pendingCount = ref(0)
export const pendingRefs = ref<Set<string>>(new Set())
export const pushProgress = ref<{ done: number; total: number } | null>(null)
export const queueItems = ref<Legacy.QueueViewItem[]>([])
export const refreshQueue = async (): Promise<void> => {}
export const refreshPendingCount = async (): Promise<void> => {}
export function createMutationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
export const enqueueMutation: typeof Legacy.enqueueMutation = async () => { throw new Error('WEB_OFFLINE_QUEUE_UNAVAILABLE') }
export const flushOutbox: typeof Legacy.flushOutbox = async () => ({ ok: 0, failed: 0, interrupted: false, entities: new Set(), failedEntries: [] })
export const clearOutbox: typeof Legacy.clearOutbox = async () => {}
export const pruneForeignOutbox: typeof Legacy.pruneForeignOutbox = async () => {}
export const getFailedEntries: typeof Legacy.getFailedEntries = async () => []
export const resetFailedRetries: typeof Legacy.resetFailedRetries = async () => {}
export const discardEntry: typeof Legacy.discardEntry = async () => {}
export const discardFailed: typeof Legacy.discardFailed = async () => {}
export const replayOutboxToCache: typeof Legacy.replayOutboxToCache = async () => {}
export function scheduleReplayOutboxToCache(): void {}
export function isNetworkError(cause: unknown): boolean {
  const error = cause as AxiosError
  return Boolean(error && !error.response && (error.code === 'ERR_NETWORK' || error.message === 'Network Error'))
}
export function errorMessage(cause: unknown): string {
  const error = cause as { response?: { data?: { error?: { message?: string } } }; message?: string }
  const message = error?.response?.data?.error?.message
  const keys: Record<string, string> = { forbidden: 'forbidden', unauthorized: 'unauthorized', 'not found': 'notFound', 'bad request': 'badRequest', conflict: 'conflict', 'validation failed': 'validation' }
  return message && keys[message] ? t('offline.server.' + keys[message]) : message ?? error?.message ?? String(cause)
}
export function entityLabel(entity: Legacy.MutationEntity): string { return t('offline.entity.' + entity) }
export function operationLabel(method: string): string {
  const verb = method.toUpperCase()
  return verb === 'POST' ? t('offline.operation.create') : ['PUT', 'PATCH'].includes(verb) ? t('offline.operation.update') : verb === 'DELETE' ? t('offline.operation.delete') : verb
}
