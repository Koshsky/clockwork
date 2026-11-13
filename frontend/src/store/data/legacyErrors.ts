import axios from 'axios'
import type { DataFailure } from '@/data/contracts'
import { apiErrorMessage } from '@/utils'

export class LegacyDomainError extends Error {
  constructor(readonly body: { code?: unknown; message?: string }) {
    super(apiErrorMessage(body))
  }
}

export function commandData<T>(response: unknown): T | null {
  const body = (response as { data?: { data?: T; error?: { code?: unknown; message?: string } } })?.data
  if (body?.error && (body.error.code != null || body.error.message)) throw new LegacyDomainError(body.error)
  return body?.data ?? null
}

export function legacyFailure(error: unknown): DataFailure {
  const response = axios.isAxiosError(error) ? error.response : undefined
  const body = error instanceof LegacyDomainError ? error.body : response?.data?.error
  const code = body?.code != null ? String(body.code) : undefined
  const status = response?.status ?? Number(code)
  let kind: DataFailure['kind'] = 'unexpected'
  if (status === 401 || code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN') kind = 'unauthenticated'
  else if (status === 403 || code === 'FORBIDDEN') kind = 'forbidden'
  else if (status === 404 || code === 'NOT_FOUND') kind = 'not-found'
  else if (status === 409 || code === 'CONFLICT') kind = 'conflict'
  else if (status === 400 || status === 422 || code === 'VALIDATION_ERROR' || code === 'BAD_REQUEST') kind = 'validation'
  else if (axios.isAxiosError(error) && error.code === 'ERR_DESKTOP_STORAGE') kind = 'storage'
  else if (status === 429 || status >= 500 || (axios.isAxiosError(error) && !response)) kind = 'unavailable'
  return {
    kind,
    message: body ? apiErrorMessage(body) : error instanceof Error ? error.message || String(error) : String(error),
    ...(code ? { code } : {}),
  }
}
