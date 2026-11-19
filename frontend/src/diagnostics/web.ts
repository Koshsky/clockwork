import { ref } from 'vue'
import { platformCapabilities } from '@/platform/context'
import { sessionEpoch } from '@/sessionSync'
import { createWebDiagnosticHistory, type WebDiagnosticKind } from './history'

export const webDiagnostics = createWebDiagnosticHistory({ version: __APP_VERSION__, context: sessionEpoch })
export const diagnosticsOpen = ref(false)
export function openDiagnostics() {
  if (platformCapabilities.kind !== 'web') return
  webDiagnostics.contextToken()
  diagnosticsOpen.value = true
}
export function reportWebError(kind: WebDiagnosticKind, error?: unknown, requestId?: unknown, scope?: symbol) {
  if (platformCapabilities.kind === 'web') webDiagnostics.capture(kind, error, requestId, scope)
}
export function resetWebDiagnostics() {
  webDiagnostics.reset()
  diagnosticsOpen.value = false
}
/** Read only the reviewed correlation header; never retain an Axios response. */
export function reportWebApiError(error: unknown, scope?: symbol) {
  let requestId: unknown
  try {
    const headers = (error as { response?: { headers?: { get?: (name: string) => unknown; 'x-request-id'?: unknown } } })?.response?.headers
    requestId = typeof headers?.get === 'function' ? headers.get('x-request-id') : headers?.['x-request-id']
  } catch { /* Missing correlation is safer than copying a header object. */ }
  reportWebError('api', error, requestId, scope)
}
