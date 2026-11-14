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
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, revision = -1, context: string | null = null, refreshing = false
  let mutationRevision: number | undefined, snapshotRevision: number | undefined, domains: Record<string, number> = {}, syncRunning = false, fullReload = false
  const dirty = new Set<string>()
  const runnable = () => fullReload || [...dirty].some(name => name !== 'members' || !syncRunning)
  const schedule = () => { if (!stopped && !timer && !refreshing && runnable()) timer = setTimeout(() => void refresh(), 50) }
  const refresh = async () => {
    timer = null
    if (stopped || refreshing) return
    if (hasActiveMutations()) { timer = setTimeout(() => void refresh(), 50); return }
    refreshing = true
    const all = fullReload, selected = new Set(dirty)
    const own = context
    fullReload = false; dirty.clear()
    try {
      if (nativeSync) await useRbacStore().refreshPermissions(true)
      const reloaders = new Map<string, () => Promise<unknown>>()
      if (nativeSync) for (const reloader of nativeSnapshotReloaders()) reloaders.set(reloader.name, reloader.run)
      else for (const entity of ['project', 'process', 'task', 'milestone', 'assignment', 'resource', 'member', 'state', 'period'] as const) {
        for (const reloader of reloadDomainsFor(entity)) reloaders.set(reloader.name, reloader.run)
      }
      for (const [name, run] of reloaders) {
        if (stopped || context !== own) return
        if (!all && !selected.has(name)) continue
        // Member pages arrive separately; one finished cycle must not fan out into N full rereads.
        if (nativeSync && name === 'members' && syncRunning) { dirty.add(name); continue }
        try { await run() } catch { /* An unavailable snapshot does not discard its command. */ }
      }
    } finally {
      refreshing = false
      schedule()
    }
  }
  const changed = (state: DesktopServiceState) => {
    localDataAvailability.value = state.storage?.phase === 'ready' ? 'available' : 'unavailable'
    syncRunning = state.sync?.running === true
    if (state.sync) {
      if (state.sync.reachable != null) isOffline.value = !state.sync.reachable || state.sync.code === 'SYNC_LOGIN_REQUIRED'
      reconnectDeadline.value = state.sync.reconnectAt
      lastWarmedAt.value = state.sync.lastPullAt
      warmupProgress.value = state.sync.progress
    }
    schedule()
    if (!state.queue || state.queue.revision === revision && context === state.queue.contextId) return
    // Progress updates do not reload data; only committed snapshots and queue changes do.
    const next = state.queue, sameContext = context === next.contextId
    const selective = nativeSync && next.snapshotDomains != null && next.mutationRevision != null && next.snapshotRevision != null
    const mutationChanged = !sameContext || !selective || next.mutationRevision !== mutationRevision
    const snapshotChanged = !sameContext || !selective || next.snapshotRevision !== snapshotRevision
    revision = state.queue.revision; context = state.queue.contextId
    mutationRevision = next.mutationRevision; snapshotRevision = next.snapshotRevision
    if ((mutationChanged || !snapshotChanged) && !pendingTimer) pendingTimer = setTimeout(() => void updatePending(), 50)
    if (!mutationChanged && !snapshotChanged) return
    if (mutationChanged || !selective) fullReload = true
    else for (const [name, version] of Object.entries(next.snapshotDomains!)) if (domains[name] !== version) {
      if (name === '*') fullReload = true
      else dirty.add(name)
    }
    domains = { ...next.snapshotDomains }
    schedule()
  }
  const unsubscribe = window.erpDesktop?.service?.subscribe(changed)
  return () => { stopped = true; if (timer) clearTimeout(timer); if (pendingTimer) clearTimeout(pendingTimer); unsubscribe?.() }
}
