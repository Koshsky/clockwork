import { platformCapabilities } from '@/platform/context'
import { reportWebError } from './web'
import { captureNativeError } from './native'
import type { WebDiagnosticKind } from './history'
export function reportDiagnosticError(kind: WebDiagnosticKind, error?: unknown) {
  if (platformCapabilities.kind === 'desktop') captureNativeError(kind, error)
  else reportWebError(kind, error)
}
