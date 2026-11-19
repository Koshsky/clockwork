const EVENTS = ['diagnostic', 'http-network', 'cache-hit', 'cache-miss', 'outbox-send', 'runtime-start', 'runtime-cleanup', 'timesheet-fallback', 'desktop-start'] as const
export type DiagnosticEventCode = typeof EVENTS[number]
export interface DiagnosticEvent {
  event: DiagnosticEventCode
  error_code: string
  status?: number
  request_id?: string
  platform?: 'web' | 'desktop'
  version?: string
  duration_ms?: number
}

const ERROR_CODES = ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED', 'STORAGE_FULL', 'STORAGE_BUSY', 'STORAGE_READ_ONLY', 'STORAGE_UNAVAILABLE', 'DESKTOP_CONTEXT_UNAVAILABLE'] as const
const API_CODES = ['INTERNAL_ERROR', 'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'TOO_MANY_REQUESTS', 'INVALID_CREDENTIALS', 'INVALID_TOKEN', 'VALIDATION_ERROR', 'CONFLICT'] as const
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Unknown fields never enter a diagnostic record, including a future support report. */
export function diagnosticEvent(event: DiagnosticEventCode, error?: unknown, metadata?: unknown): DiagnosticEvent {
  const result: DiagnosticEvent = { event: EVENTS.includes(event) ? event : 'diagnostic', error_code: 'UNEXPECTED' }
  try {
    const input = record(error), response = record(input.response), body = record(record(response.data).error)
    const code = input.code, apiCode = body.code, status = response.status
    if (ERROR_CODES.includes(code as typeof ERROR_CODES[number])) result.error_code = code as string
    else if (API_CODES.includes(apiCode as typeof API_CODES[number])) result.error_code = apiCode as string
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status
    const fields = record(metadata)
    const platform = fields.platform, version = fields.version, requestId = fields.request_id, duration = fields.duration_ms
    if (platform === 'web' || platform === 'desktop') result.platform = platform
    if (typeof version === 'string' && /^(dev|\d{1,6}\.\d{1,6}\.\d{1,6})$/.test(version)) result.version = version
    if (typeof requestId === 'string' && /^[a-f0-9]{32}$/.test(requestId)) result.request_id = requestId
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 86400000) result.duration_ms = duration
  } catch {
    // Diagnostic input must not interrupt the operation being diagnosed.
  }
  return result
}
