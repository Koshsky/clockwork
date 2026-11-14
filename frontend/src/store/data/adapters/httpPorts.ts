import { AxiosHeaders, type AxiosRequestConfig, type AxiosResponse } from 'axios'
import type { CommandPort, ReadPort } from '@/data/contracts'
import { businessBinding } from '@/data/businessRequest'
import { readSenders, commandSenders } from './httpSenders'
import { httpConfiguration } from './httpConfiguration'
import { commandData, legacyFailure } from '../legacyErrors'
import { rememberFailure, rememberResponse } from './failureOrigin'

type Sender = (input: never, options: AxiosRequestConfig, configuration: ReturnType<typeof httpConfiguration>) => Promise<AxiosResponse>
export function createHttpPorts(configuration = httpConfiguration): { reads: ReadPort; commands: CommandPort } {
  return {
    reads: { async read(operation, input, options) {
      if (options.signal?.aborted) return { status: 'cancelled' }
      try {
        const send = readSenders[operation] as Sender | undefined
        if (!send) return { status: 'failed', error: { kind: 'unavailable', code: 'APPLICATION_OPERATION_UNAVAILABLE', message: 'APPLICATION_OPERATION_UNAVAILABLE' } }
        const response = await send(input as never, { signal: options.signal }, configuration())
        const binding = businessBinding(operation), raw = commandData<unknown>(response)
        const value = binding.unwrap ? (raw as Record<string, unknown> | null)?.[binding.unwrap] : raw
        const data = binding.page ? { ...(value as object), limit: (input as { limit?: number })?.limit ?? 50, offset: (input as { offset?: number })?.offset ?? 0 } : value
        if (options.signal?.aborted) return { status: 'cancelled' }
        return rememberResponse({ status: 'ok' as const, data: data as never, source: (response as { __erpLocalSnapshot?: boolean }).__erpLocalSnapshot ? 'snapshot' as const : 'refresh' as const }, response)
      } catch (cause) {
        if (options.signal?.aborted) return { status: 'cancelled' }
        return { status: 'failed', error: rememberFailure(legacyFailure(cause), cause) }
      }
    } },
    commands: { async execute(operation, input, options) {
      if (options?.signal?.aborted) return { status: 'rejected', operationId: options.operationId, error: { kind: 'unavailable', code: 'APPLICATION_CANCELLED', message: 'APPLICATION_CANCELLED' } }
      const send = commandSenders[operation] as Sender | undefined
      if (!send) return { status: 'rejected', error: { kind: 'unavailable', code: 'APPLICATION_OPERATION_UNAVAILABLE', message: 'APPLICATION_OPERATION_UNAVAILABLE' } }
      try {
        const response = await send(input as never, { signal: options?.signal, headers: { ...(options?.operationId ? { 'Idempotency-Key': options.operationId } : {}), ...(options?.temporaryId != null ? { 'X-Desktop-Temp-ID': String(options.temporaryId) } : {}) } }, configuration())
        return rememberResponse(AxiosHeaders.from(response.headers as Parameters<typeof AxiosHeaders.from>[0]).get('Operation-Status') === 'queued' ? { status: 'queued' as const, operationId: options?.operationId } : { status: 'confirmed' as const, data: commandData(response) as never, ...(options?.operationId ? { operationId: options.operationId } : {}) }, response)
      } catch (cause) {
        const error = rememberFailure(legacyFailure(cause), cause)
        return { status: error.kind === 'unavailable' || error.kind === 'storage' ? 'unknown' : error.kind === 'conflict' ? 'conflict' : 'rejected', error, ...(options?.operationId ? { operationId: options.operationId } : {}) }
      }
    } },
  }
}
