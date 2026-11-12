import { watch } from 'vue'
import { useAuthStore } from '@/store'
import { isLoggedOut } from '@/loggedOut'
import { shouldAutoSync } from '@/settings'
import { isOffline, probeBackend, reconnectDeadline } from '@/offline/state'
import { refreshActiveReads, stopActiveReads, resumeActiveReads } from '@/data/activeReads'
import { cancelApiReads } from '@/store/data/apiReads'
import { notePull } from '@/offline/freshness'
import { hasActiveMutations } from '@/offline/mutationGuard'
import { refreshPendingCount } from '@/offline/outbox'
import { startSessionMaintenance, stopDomainRefresh, resumeDomainRefresh } from '@/offline/sync'
import { pullStaleCycle, scheduleWarmup, stopWarmup, resumeWarmup } from '@/offline/warmup'
import { backendReachability, legacyQueueAvailability } from './state'
import { createRuntime } from './lifecycle'
import type { legacyQueueRecovery } from './legacyQueue'

export function createWebRuntime() {
  let alive = () => false
  let checking = false
  let cycling = false
  let legacy: ReturnType<typeof legacyQueueRecovery> | null = null
  let preparing: Promise<void> | null = null
  let prepared = false
  let recovering: Promise<void> | null = null
  const canWork = () => alive() && !document.hidden && shouldAutoSync() && !isLoggedOut()
  async function prepareLegacyQueue() {
    if (prepared || legacyQueueAvailability.value !== 'pending' || !alive() || hasActiveMutations()) return
    preparing ??= import('./legacyQueue').then(async module => {
      if (!alive()) return
      legacy = module.legacyQueueRecovery()
      await legacy.prepare()
      prepared = true
    }).finally(() => { preparing = null })
    await preparing
  }
  async function recoverLegacyQueue() {
    if (recovering) return recovering
    if (!canWork() || isOffline.value || hasActiveMutations()) return
    if (legacyQueueAvailability.value !== 'pending') return
    recovering = (async () => {
      await prepareLegacyQueue()
      if (canWork() && !isOffline.value && !hasActiveMutations() && legacyQueueAvailability.value === 'pending') await legacy?.push()
    })().finally(() => { recovering = null })
    return recovering
  }
  async function checkConnection() {
    if (!alive() || checking) return
    checking = true
    const wasOffline = isOffline.value
    try {
      const reachable = await probeBackend()
      if (!alive()) return
      backendReachability.value = reachable ? 'reachable' : 'unreachable'
      isOffline.value = !reachable
      reconnectDeadline.value = reachable ? null : Date.now() + 60000
      if (reachable && wasOffline && canWork()) {
        await recoverLegacyQueue()
        if (alive() && !isOffline.value) scheduleWarmup()
      }
    } finally { checking = false }
  }
  async function minute() {
    if (cycling || !canWork() || hasActiveMutations()) return
    cycling = true
    try {
      if (isOffline.value) await checkConnection()
      if (!canWork() || isOffline.value) return
      await refreshPendingCount()
      if (!canWork() || isOffline.value || hasActiveMutations()) return
      await recoverLegacyQueue()
      if (canWork() && !isOffline.value) {
        const refreshed = await pullStaleCycle()
        if (canWork() && !isOffline.value && !hasActiveMutations()) await refreshActiveReads()
        if (alive() && refreshed > 0) notePull()
      }
    } catch {
      // A failed legacy recovery must not pull stale server data over pending work.
    } finally { cycling = false }
  }
  return createRuntime('web', async scope => {
    alive = scope.active
    resumeActiveReads()
    scope.onStop(stopActiveReads)
    scope.onStop(cancelApiReads)
    resumeWarmup()
    resumeDomainRefresh()
    scope.onStop(stopWarmup)
    scope.onStop(stopDomainRefresh)
    scope.onStop(startSessionMaintenance())
    const offline = () => {
      isOffline.value = true
      backendReachability.value = 'unreachable'
      reconnectDeadline.value = Date.now() + 60000
    }
    const online = () => { if (canWork()) void checkConnection().catch(() => {}) }
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    scope.onStop(() => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      reconnectDeadline.value = null
    })
    const heartbeat = window.setInterval(() => {
      if (canWork() && (!isOffline.value || Date.now() >= (reconnectDeadline.value ?? 0))) void checkConnection().catch(() => {})
    }, 10000)
    const refresh = window.setInterval(() => void minute(), 60000)
    scope.onStop(() => { window.clearInterval(heartbeat); window.clearInterval(refresh) })
    scope.onStop(watch(legacyQueueAvailability, state => {
      if (state === 'pending') void prepareLegacyQueue().then(recoverLegacyQueue).catch(() => {})
    }))
    const auth = useAuthStore()
    scope.onStop(watch(() => [auth.isAuthenticated, auth.sessionMode] as const, () => {
      if (auth.isAuthenticated && auth.sessionMode === 'online' && canWork()) {
        void checkConnection().then(recoverLegacyQueue).catch(() => {})
      }
    }))
    // Discovery is optional and never delays first paint or login. Failure stays
    // unknown/unavailable; it is not proof of an empty legacy queue.
    void refreshPendingCount().then(() => {
      if (scope.active()) return prepareLegacyQueue().then(recoverLegacyQueue)
    }).catch(() => {})
    if (canWork()) void checkConnection().catch(() => {})
  }, checkConnection)
}
