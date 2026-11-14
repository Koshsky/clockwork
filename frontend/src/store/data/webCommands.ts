import axios, { AxiosHeaders, type AxiosRequestConfig } from 'axios'
import { shallowRef } from 'vue'
import type { CommandResult } from '@/data/contracts'
import { getApiUrl } from '@/config'
import { currentUserId } from '@/offline/cache'
import { createMutationKey, type MutationEntity } from '@/offline/outbox'
import { beginMutation } from '@/offline/mutationGuard'
import { scheduleDomainRefresh } from '@/offline/sync'
import { t } from '@/i18n'
import { commandData, legacyFailure } from './legacyErrors'

export interface WebCommandOptions<T = unknown> {
  key: unknown
  entity?: MutationEntity
  targetId?: number
  target?: unknown
  targets?: unknown[]
  sensitive?: boolean
  replayBatch?: boolean
  operationId?: string
  call: (options: AxiosRequestConfig) => Promise<unknown>
  apply: (data: T | null) => void | Promise<void>
  onError: (message: string) => void
  onConfirmed?: () => void
}
interface Notice { id: string; retryable: boolean; busy: boolean; sensitive: boolean }
interface Operation {
  id: string
  scope: string
  flight?: Promise<CommandResult<unknown>>
  retry?: () => Promise<CommandResult<unknown>>
  terminal?: CommandResult<unknown>
  sensitive: boolean
  controller?: AbortController
  started: number
  current: () => boolean
}
const operations = new Map<string, Operation>()
let generation = 0
const scope = () => JSON.stringify([getApiUrl(), currentUserId(), generation])
export const uncertainCommands = shallowRef<Notice[]>([])
export const webPendingRefs = shallowRef(new Set<string>())
const pending = new Map<string, number>()
const versions = new Map<string, number>()
const signature = (value: unknown) => JSON.stringify(value, (_, part) => part && typeof part === 'object' && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)

export function resetWebCommands(): void {
  generation++
  for (const operation of operations.values()) operation.controller?.abort()
  operations.clear()
  uncertainCommands.value = []
  pending.clear()
  versions.clear()
  webPendingRefs.value = new Set()
}
function mark(key: string | undefined, delta: number) {
  if (!key) return
  const count = (pending.get(key) ?? 0) + delta
  if (count > 0) pending.set(key, count)
  else pending.delete(key)
  webPendingRefs.value = new Set(pending.keys())
}
export function dismissUncertainCommand(id: string): void {
  const entry = [...operations.entries()].find(([, operation]) => operation.id === id)
  if (entry?.[1].flight) return
  if (entry && (entry[1].sensitive || !entry[1].retry)) operations.delete(entry[0])
  uncertainCommands.value = uncertainCommands.value.filter(item => item.id !== id)
}
export async function retryUncertainCommand(id: string): Promise<void> {
  const operation = [...operations.values()].find(item => item.id === id)
  if (operation?.scope !== scope()) return
  // The current backend retains idempotency receipts for 24 hours.
  if (!operation.current() || Date.now() - operation.started >= 23 * 60 * 60 * 1000) {
    operation.retry = undefined
    uncertainCommands.value = uncertainCommands.value.map(item => item.id === id ? { ...item, retryable: false } : item)
    return
  }
  await (operation.flight ?? operation.retry?.())
}

export function runWebCommand<T>(options: WebCommandOptions<T>): Promise<CommandResult<T | null>> {
  const ownScope = scope()
  // Secret-bearing commands are never retained as retry payloads or cache keys.
  const key = signature([ownScope, options.sensitive ? ['sensitive', options.key] : options.key])
  const existing = operations.get(key)
  if (existing?.flight) return existing.flight as Promise<CommandResult<T | null>>
  if (existing?.retry && existing.current() && Date.now() - existing.started < 23 * 60 * 60 * 1000) return existing.retry() as Promise<CommandResult<T | null>>
  if (existing?.terminal) {
    const result = existing.terminal as CommandResult<T | null>
    if (result.status === 'confirmed') operations.delete(key)
    if ('error' in result) options.onError(result.error.message)
    return Promise.resolve(result)
  }
  const targets = (options.targets ?? [options.target ?? (options.entity && options.targetId != null && options.targetId >= 0 ? [options.entity, options.targetId] : options.key)]).map(target => signature([ownScope, target]))
  const revisions = targets.map(target => { const version = (versions.get(target) ?? 0) + 1; versions.set(target, version); return [target, version] as const })
  const operation: Operation = { id: options.operationId ?? createMutationKey(), scope: ownScope, sensitive: !!options.sensitive, started: Date.now(), current: () => revisions.every(([target, version]) => versions.get(target) === version) }
  operations.set(key, operation)
  let send = options.call
  const run = (): Promise<CommandResult<T | null>> => {
    if (operation.flight) return operation.flight as Promise<CommandResult<T | null>>
    const finish = options.entity ? beginMutation() : () => {}
    const ref = options.entity && options.targetId != null ? options.entity + ':' + options.targetId : undefined
    mark(ref, 1)
    uncertainCommands.value = uncertainCommands.value.map(item => item.id === operation.id ? { ...item, busy: true } : item)
    const controller = new AbortController()
    operation.controller = controller
    let acknowledged = false
    let resolve!: (value: CommandResult<T | null>) => void
    let reject!: (cause: unknown) => void
    const flight = new Promise<CommandResult<T | null>>((done, fail) => { resolve = done; reject = fail })
    operation.flight = flight
    const execute = async (): Promise<CommandResult<T | null>> => {
      try {
        const response = await send({ signal: controller.signal, headers: { 'Idempotency-Key': operation.id } })
        const data = commandData<T>(response)
        acknowledged = true
        if (ownScope !== scope()) return { status: 'unknown', operationId: operation.id, error: { kind: 'unexpected', message: t('common.commandSessionChanged') } }
        finish()
        if (operation.current()) {
          await options.apply(data)
          if (operation.current()) options.onConfirmed?.()
        }
        if (options.entity) scheduleDomainRefresh([options.entity])
        const recovered = operation.terminal?.status === 'unknown'
        const result: CommandResult<T | null> = { status: 'confirmed', data, operationId: operation.id }
        dismiss()
        if (recovered) {
          // The original editor can acknowledge the retry without creating a second object.
          operation.retry = undefined
          operation.terminal = result
          operations.set(key, operation)
        }
        return result
      } catch (cause) {
        const failure = legacyFailure(cause)
        const unknown = acknowledged || failure.kind === 'unavailable' || axios.isCancel(cause)
        if (ownScope !== scope()) return { status: 'unknown', operationId: operation.id, error: failure }
        finish()
        const message = unknown ? t(options.sensitive ? 'common.commandSecretUnknown' : 'common.commandUnknown') : failure.message
        if (unknown) {
          const config = axios.isAxiosError(cause) ? cause.config : undefined
          if (!options.sensitive && !acknowledged && config && operation.current()) {
            // Replay the exact serialized request, even if the editor's input changed.
            const saved: AxiosRequestConfig = { ...config, headers: AxiosHeaders.from(config.headers), signal: undefined, cancelToken: undefined }
            send = options.replayBatch ? options.call : request => axios.request({ ...saved, signal: request.signal, headers: new AxiosHeaders(config.headers).set('Idempotency-Key', operation.id) })
            operation.retry = run
          }
          uncertainCommands.value = [...uncertainCommands.value.filter(item => item.id !== operation.id), { id: operation.id, retryable: !!operation.retry, busy: false, sensitive: !!options.sensitive }]
        } else dismiss()
        const result: CommandResult<T | null> = { status: unknown ? 'unknown' : failure.kind === 'conflict' ? 'conflict' : 'rejected', operationId: operation.id, error: { ...failure, message } }
        if (unknown) operation.terminal = result
        if (operation.current()) options.onError(message)
        return result
      } finally {
        finish()
        if (ownScope === scope()) mark(ref, -1)
        operation.flight = undefined
      }
    }
    void execute().then(resolve, reject)
    return flight
  }
  const dismiss = () => {
    operations.delete(key)
    uncertainCommands.value = uncertainCommands.value.filter(item => item.id !== operation.id)
  }
  return run()
}
