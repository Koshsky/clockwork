import { platformCapabilities } from '@/platform/context'
import { openDiagnostics as openWebDiagnostics } from './web'
import { openNativeDiagnostics } from './native'
export function openDiagnostics() {
  if (platformCapabilities.kind === 'desktop') void openNativeDiagnostics()
  else openWebDiagnostics()
}
