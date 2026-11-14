import { t, currentLocale } from '@/i18n'
import type { Configuration } from '@/api'
import axios, { AxiosError, AxiosHeaders, type AxiosResponse, type RawAxiosRequestConfig } from 'axios'
import type { CommandOperations, DataFailure, ReadOperations } from '@/data/contracts'
import { businessBindings, businessRequest } from '@/data/businessRequest'
import { applicationPorts, nativeBusinessPorts } from './applicationPorts'
import { failureOrigin, responseOrigin } from './adapters/failureOrigin'
import { desktopQueueMessage } from '@/offline/desktopQueue'
import { desktopSessionState } from '@/session/desktop'

const requestHeaders = (options?: RawAxiosRequestConfig) => AxiosHeaders.from(options?.headers as Parameters<typeof AxiosHeaders.from>[0])

export function failed(error: DataFailure): never {
  const original = failureOrigin(error)
  if (original) throw original
  const status = { unauthenticated: 401, forbidden: 403, 'not-found': 404, validation: 400, conflict: 409, unavailable: 503, storage: 503, unexpected: 500 }[error.kind]
  const native = /^(COMMAND|STORAGE)_/.test(error.code || '')
  const message = native ? desktopQueueMessage(error.code!) : error.code === 'SESSION_OFFLINE' ? t('common.localDataMissing') : /^(DESKTOP|SESSION|APPLICATION)_/.test(error.code || '') ? t('common.networkError') : error.message
  throw new AxiosError(message, native ? 'ERR_DESKTOP_STORAGE' : 'ERR_BAD_RESPONSE', undefined, undefined, { status, data: { error: { message, code: error.code } } } as AxiosResponse)
}
function response<T>(data: T, options: RawAxiosRequestConfig | undefined, metadata: Record<string, unknown> = {}): AxiosResponse<{ data: T; error: Record<string, never> }> {
  return { data: { data, error: {} }, status: 200, statusText: '', headers: new AxiosHeaders(), config: { ...options, headers: requestHeaders(options) }, ...metadata }
}
export async function readResponse<K extends keyof ReadOperations>(operation: K, input: ReadOperations[K]['input'], options?: RawAxiosRequestConfig, configuration?: () => Configuration) {
  const selected = applicationPorts(configuration), ports = selected instanceof Promise ? await selected : selected
  const snapshot = requestHeaders(options).get('X-Desktop-Read-Source') === 'snapshot'
  const result = await ports.reads.read(operation, input, { source: snapshot ? 'snapshot' : 'refresh', signal: options?.signal as AbortSignal | undefined, ...(nativeBusinessPorts() ? { locale: currentLocale() } : {}) })
  if (result.status === 'cancelled') throw new axios.CanceledError()
  if (result.status === 'failed') failed(result.error)
  if (result.status === 'missing') failed({ kind: 'unavailable', code: 'LOCAL_SNAPSHOT_MISSING', message: t('common.localDataMissing') })
  const original = responseOrigin(result)
  if (original) return original as AxiosResponse<{ data: K extends 'resource.calendar' ? { resources: ReadOperations[K]['output'] } : ReadOperations[K]['output']; error: Record<string, never> }>
  const binding = businessBindings.find(binding => binding.operation === operation)
  const data = binding?.unwrap ? { [binding.unwrap]: result.data } : result.data
  return response(data, options, { ...(result.baseline ? { __erpBaseline: result.baseline } : {}), ...(result.source === 'snapshot' ? { __erpLocalSnapshot: true } : {}) }) as AxiosResponse<{ data: K extends 'resource.calendar' ? { resources: ReadOperations[K]['output'] } : ReadOperations[K]['output']; error: Record<string, never> }>
}
export async function commandResponse<K extends keyof CommandOperations>(operation: K, input: CommandOperations[K]['input'], options?: RawAxiosRequestConfig, configuration?: () => Configuration) {
  if (options?.signal?.aborted) throw new axios.CanceledError()
  const sessionContextId = desktopSessionState.value?.contextId
  const headers = requestHeaders(options), descriptor = businessRequest(operation, input)
  const temporaryId = headers.get('X-Desktop-Temp-ID') ? Number(headers.get('X-Desktop-Temp-ID')) : undefined
  let preconditions: Record<string, string> | undefined
  if (nativeBusinessPorts() && !/^(account|comment|rbac|template)\./.test(operation)) {
    try { preconditions = (await import('./nativeBaselines')).capture(descriptor) }
    catch (cause) { failed({ kind: 'storage', code: cause instanceof Error ? cause.message : 'COMMAND_BASELINE_REQUIRED', message: String(cause) }) }
  }
  const selected = applicationPorts(configuration, sessionContextId), ports = selected instanceof Promise ? await selected : selected
  const result = await ports.commands.execute(operation, input, { ...(headers.get('Idempotency-Key') ? { operationId: String(headers.get('Idempotency-Key')) } : {}), ...(temporaryId != null ? { temporaryId } : {}), ...(preconditions ? { preconditions } : {}), ...(options?.signal ? { signal: options.signal as AbortSignal } : {}), ...(nativeBusinessPorts() ? { locale: currentLocale() } : {}) })
  if (result.status !== 'confirmed' && result.status !== 'queued') failed(result.error)
  const original = responseOrigin(result)
  if (original) return original as AxiosResponse<{ data: CommandOperations[K]['output'] | null; error: Record<string, never> }>
  const queued = result.status === 'queued'
  const metadata = nativeBusinessPorts() ? {
    __erpMutation: { ...descriptor, preconditions }, __erpOperationId: result.operationId, __erpTempId: temporaryId,
    __erpPreconditions: preconditions, __erpContext: result.sessionContextId ?? sessionContextId,
    ...(result.baseline ? { __erpBaseline: result.baseline } : {}),
  } : {}
  return response(queued ? null : result.data, { ...options, headers: { ...headers.toJSON(), ...(result.operationId ? { 'Idempotency-Key': result.operationId } : {}) } }, {
    ...metadata, status: queued ? 202 : 200, headers: new AxiosHeaders(queued ? { 'Operation-Status': 'queued' } : {}),
  })
}
