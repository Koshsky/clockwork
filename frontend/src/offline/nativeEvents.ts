import { localDataAvailability } from '@/platform/state'
import { refreshPendingCount } from './outbox'
import { reloadDomainsFor } from './sync'
import { hasActiveMutations } from './mutationGuard'
import type { DesktopServiceState } from '@/data/desktopBridge'
export { refreshPendingCount }

export function nativeQueueChanged(): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, revision = -1, context: string | null = null
  const refresh = async () => {
    timer = null
    if (stopped) return
    if (hasActiveMutations()) { timer = setTimeout(() => void refresh(), 50); return }
    await refreshPendingCount()
    const reloaders = new Map<string, () => Promise<unknown>>()
    for (const entity of ['project', 'process', 'task', 'milestone', 'assignment', 'resource', 'member', 'state', 'period'] as const) {
      for (const reloader of reloadDomainsFor(entity)) reloaders.set(reloader.name, reloader.run)
    }
    for (const run of reloaders.values()) {
      if (stopped) return
      try { await run() } catch { /* An unavailable snapshot does not discard its command. */ }
    }
  }
  const changed = (state: DesktopServiceState) => {
    localDataAvailability.value = state.storage?.phase === 'ready' ? 'available' : 'unavailable'
    if (!state.queue || state.queue.revision === revision && context === state.queue.contextId) return
    revision = state.queue.revision; context = state.queue.contextId
    if (!timer) timer = setTimeout(() => void refresh(), 50)
  }
  const unsubscribe = window.erpDesktop?.service?.subscribe(changed)
  return () => { stopped = true; if (timer) clearTimeout(timer); unsubscribe?.() }
}
