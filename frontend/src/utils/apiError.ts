/**
 * Maps backend machine-readable codes to local texts. Catalog keys are
 * resolved through t() at call time, so the text follows the interface
 * language.
 */
import { t } from '@/i18n'

const CODE_KEYS: Record<string, string> = {
  BAD_REQUEST: 'errors.code.badRequest',
  UNAUTHORIZED: 'errors.code.unauthorized',
  FORBIDDEN: 'errors.code.forbidden',
  NOT_FOUND: 'errors.code.notFound',
  TOO_MANY_REQUESTS: 'errors.code.tooManyRequests',
  INVALID_CREDENTIALS: 'errors.code.invalidCredentials',
  INVALID_TOKEN: 'errors.code.invalidToken',
  VALIDATION_ERROR: 'errors.code.validation',
  INTERNAL_ERROR: 'errors.code.internal',
}

/**
 * Codes whose generic text beats the server message: they are technical (an
 * internal failure or a transport-level rejection) and the server text carries
 * nothing the user can act on. For every other code a specific backend message
 * is more useful than the generic one — and it arrives already localized,
 * because the client sends Accept-Language.
 */
const GENERIC_FIRST = new Set(['INTERNAL_ERROR', 'UNAUTHORIZED', 'INVALID_TOKEN', 'TOO_MANY_REQUESTS'])

/** Local text for an error code; null if the code is unknown. */
export function errorTextByCode(code?: string): string | null {
  if (!code) return null
  const key = CODE_KEYS[code]
  return key ? t(key) : null
}

/**
 * Human-readable error message from the { data, error } response body.
 * Priority: a specific backend message (already in the active language) → the
 * local text of the code → the caller fallback → the generic request failure.
 */
export function apiErrorMessage(
  errorBody: { message?: string; code?: unknown } | null | undefined,
  fallback = '',
): string {
  const code = errorBody?.code != null ? String(errorBody.code) : undefined
  const serverText = errorBody?.message?.trim() ?? ''
  if (serverText && !GENERIC_FIRST.has(code ?? '')) return serverText
  const byCode = errorTextByCode(code)
  if (byCode) return byCode
  if (serverText) return serverText
  return fallback || t('errors.request')
}
