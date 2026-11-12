import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { getApiUrl } from '@/config'
import { currentLocale, t } from '@/i18n'
import { currentUserId } from '@/offline/cache'
import { readStamp, mayApplyRead } from '@/offline/mutationGuard'
import { createRequestCache, ReadCancelled } from '@/data/requestCache'
import { LegacyDomainError } from './legacyErrors'

let epoch = 0
export const apiReadScope = () => JSON.stringify([getApiUrl(), currentUserId(), currentLocale(), epoch])
const scope = apiReadScope
const requests = createRequestCache(() => ({ scope: scope(), revision: readStamp() }), context => context.scope === scope() && mayApplyRead(context.revision))

export function isReadCancelled(error: unknown): boolean { return error instanceof ReadCancelled || axios.isCancel(error) }
export function isReadForbidden(error: unknown): boolean { return axios.isAxiosError(error) && error.response?.status === 403 }
export function invalidateApiReads(): void { epoch++; requests.invalidate() }
export function cancelApiReads(): void { requests.cancel() }
export function readPending(channel: string): boolean { return requests.pending(channel) }

export function readApi<T extends AxiosResponse>(
  channel: string, query: unknown, send: (options: AxiosRequestConfig) => Promise<T>,
  preferCache = false, signal?: AbortSignal,
): Promise<T> {
  const expected = scope()
  const stamp = readStamp()
  return requests.read(channel, query, async signal => {
    const response = await send({ signal })
    const body = response.data as { error?: { code?: unknown; message?: string } } | undefined
    if (body?.error && (body.error.code != null || body.error.message)) throw new LegacyDomainError(body.error)
    return response
  }, { preferCache, signal }).then(response => {
    const data = response.data == null ? response.data : JSON.parse(JSON.stringify(response.data))
    // A resolved cache hit can cross an account reset at the consumer's await.
    return { ...response, get data() {
      if (expected !== scope() || !mayApplyRead(stamp)) throw new ReadCancelled()
      return data
    } } as T
  }).catch(error => {
    if (axios.isAxiosError(error) && !error.response && !axios.isCancel(error)) error.message = t('common.networkError')
    throw error
  })
}
