import { nativeQueue, queuedResponse } from '@/offline/desktopQueue'
import axios, { type AxiosError, type Method } from 'axios'
import type { CommandResult } from '@/data/contracts'
import { isOffline } from '@/offline/state'
import { beginMutation } from '@/offline/mutationGuard'
import { enqueueMutation, isNetworkError, type MutationEntity } from '@/offline/outbox'
import { scheduleDomainRefresh } from '@/offline/sync'
import { LegacyDomainError, legacyFailure } from './legacyErrors'

export interface LegacyMutationOptions<T = unknown> {
  call: (options?: import('axios').AxiosRequestConfig) => Promise<unknown>
  entity: MutationEntity
  tempId?: number
  operationId?: string
  onConfirmed?: () => void
  apply: (data: T | null) => void | Promise<void>
  optimistic: () => void
  onError: (message: string) => void
}

export async function runLegacyMutation<T = unknown>(opts: LegacyMutationOptions<T>): Promise<CommandResult<T | null>> {
  const finish = beginMutation()
  let acknowledged = false
  let operationId = opts.operationId
  const identified = (result: CommandResult<T | null>): CommandResult<T | null> => operationId ? { ...result, operationId } : result
  try {
    const resp = await opts.call(opts.tempId != null ? { headers: { 'X-Desktop-Temp-ID': String(opts.tempId) } } : {})
    if (nativeQueue && queuedResponse(resp)) {
      opts.optimistic()
      const native = resp as { __erpMutation?: import('./desktopPreconditions').DesktopBaselineRequest; __erpOperationId?: string; __erpTempId?: number; __erpContext?: string }
      if (native.__erpMutation && native.__erpOperationId) {
        (await import('./nativeBaselines')).observe(native.__erpMutation, native.__erpOperationId, native.__erpTempId, native.__erpContext)
        operationId = native.__erpOperationId
      }
      return identified({ status: 'queued' })
    }
    const headers = (resp as { config?: { headers?: Record<string, unknown> } } | undefined)?.config?.headers
    operationId ??= String(headers?.['Idempotency-Key'] ?? headers?.['idempotency-key'] ?? '') || undefined
    const body = (resp as { data?: { data?: T; error?: { code?: unknown; message?: string } } } | undefined)?.data
    if (body?.error && (body.error.code != null || body.error.message)) throw new LegacyDomainError(body.error)
    acknowledged = true
    // The useful DTO is resp.data.data, never resp.data.data.data: the latter
    // silently loses ordinary create/update responses.
    const data = body?.data ?? null
    finish()
    await opts.apply(data)
    const native = resp as { __erpBaseline?: Record<string, string>; __erpMutation?: import('./desktopPreconditions').DesktopBaselineRequest; __erpPreconditions?: Record<string, string>; __erpContext?: string }
    if (nativeQueue && native.__erpBaseline && native.__erpMutation) (await import('./nativeBaselines')).acknowledge(native.__erpMutation, data, native.__erpBaseline, native.__erpPreconditions, native.__erpContext)
    opts.onConfirmed?.()
    if (!isOffline.value) scheduleDomainRefresh([opts.entity])
    return identified({ status: 'confirmed', data })
  } catch (e: unknown) {
    const err = e as AxiosError
    operationId ??= String(err?.config?.headers?.['Idempotency-Key'] ?? err?.config?.headers?.['idempotency-key'] ?? '') || undefined
    // A local apply failure cannot turn an acknowledged write into a new queued write.
    if (!nativeQueue && !acknowledged && err?.config && isNetworkError(e) && !axios.isCancel(e)) {
      try {
        await enqueueMutation({
          entity: opts.entity,
          tempId: opts.tempId,
          method: (err.config.method ?? 'get') as Method,
          url: axios.getUri(err.config),
          body: err.config.data,
          idempotencyKey: String(err.config.headers?.['Idempotency-Key'] ?? err.config.headers?.['idempotency-key'] ?? '') || undefined,
        })
      } catch (storageError) {
        finish()
        opts.onError(legacyFailure(e).message)
        return identified({ status: 'unknown', error: { ...legacyFailure(storageError), kind: 'storage' } })
      }
      opts.optimistic()
      return identified({ status: 'queued' })
    }
    finish()
    const error = legacyFailure(e)
    opts.onError(error.message)
    return identified({ status: acknowledged || error.kind === 'unavailable' || error.kind === 'storage' ? 'unknown' : error.kind === 'conflict' ? 'conflict' : 'rejected', error })
  } finally {
    finish()
  }
}

export async function runMutation<T = unknown>(opts: LegacyMutationOptions<T>): Promise<boolean> {
  const result = await runLegacyMutation(opts)
  return result.status === 'confirmed' || result.status === 'queued'
}
