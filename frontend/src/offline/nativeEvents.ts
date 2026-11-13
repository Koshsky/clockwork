import { localDataAvailability } from '@/platform/state'
import { refreshPendingCount } from './outbox'
import { useRbacStore } from '@/store'
import { nativeSnapshotReloaders } from './nativeHydration'
import { nativeSync } from './desktopQueue'
import { warmupProgress, lastWarmedAt } from './warmup'
import { isOffline, reconnectDeadline } from './state'
import { reloadDomainsFor } from './sync'
import { hasActiveMutations } from './mutationGuard'
import type { DesktopServiceState } from '@/data/desktopBridge'
export { refreshPendingCount }

export function nativeQueueChanged(): () => void {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  const updatePending = async () => {
    pendingTimer = null
    if (stopped) return
    if (hasActiveMutations()) { pendingTimer = setTimeout(() => void updatePending(), 50); return }
    await refreshPendingCount()
  }
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, revision = -1, context: string | null = null, syncRevision = -1, refreshing = false, dirty = false
  const refresh = async () => {
    timer = null
    if (stopped || refreshing) return
    if (hasActiveMutations()) { timer = setTimeout(() => void refresh(), 50); return }
    refreshing = true; dirty = false
    try {
      if (nativeSync) await useRbacStore().refreshPermissions(true)
      const reloaders = new Map<string, () => Promise<unknown>>()
      if (nativeSync) for (const reloader of nativeSnapshotReloaders()) reloaders.set(reloader.name, reloader.run)
      else for (const entity of ['project', 'process', 'task', 'milestone', 'assignment', 'resource', 'member', 'state', 'period'] as const) {
        for (const reloader of reloadDomainsFor(entity)) reloaders.set(reloader.name, reloader.run)
      }
      for (const run of reloaders.values()) {
        if (stopped) return
        try { await run() } catch { /* An unavailable snapshot does not discard its command. */ }
      }
    } finally {
      refreshing = false
      if (dirty && !stopped && !timer) timer = setTimeout(() => void refresh(), 50)
    }
  }
  const changed = (state: DesktopServiceState) => {
    localDataAvailability.value = state.storage?.phase === 'ready' ? 'available' : 'unavailable'
    if (state.sync) {
      if (state.sync.reachable != null) isOffline.value = !state.sync.reachable || state.sync.code === 'SYNC_LOGIN_REQUIRED'
      reconnectDeadline.value = state.sync.reconnectAt
      lastWarmedAt.value = state.sync.lastPullAt
      warmupProgress.value = state.sync.progress
    }
    if (!state.queue || state.queue.revision === revision && context === state.queue.contextId && syncRevision === (state.sync?.revision ?? -1)) return
    // Progress updates do not reload data; only committed snapshots and queue changes do.
    syncRevision = state.sync?.revision ?? -1
    if (state.queue.revision === revision && context === state.queue.contextId) return
    revision = state.queue.revision; context = state.queue.contextId
    if (!pendingTimer) pendingTimer = setTimeout(() => void updatePending(), 50)
    dirty = true
    if (!timer && !refreshing) timer = setTimeout(() => void refresh(), 50)
  }
  const unsubscribe = window.erpDesktop?.service?.subscribe(changed)
  return () => { stopped = true; if (timer) clearTimeout(timer); if (pendingTimer) clearTimeout(pendingTimer); unsubscribe?.() }
}
