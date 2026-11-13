import { shallowRef } from 'vue'
import type { DesktopServiceState } from './desktopBridge'

export const desktopDataState = shallowRef<DesktopServiceState | null>(null)
export function observeDesktopState(next: DesktopServiceState): void {
  const current = desktopDataState.value
  if (!current || current.instanceId !== next.instanceId || next.revision >= current.revision) desktopDataState.value = next
}
