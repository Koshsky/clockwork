import { watch } from 'vue'
import { useAuthStore } from '@/store'
import { isLoggedOut } from '@/loggedOut'
import { shouldAutoSync } from '@/settings'
import { isOffline, probeBackend, reconnectDeadline } from '@/offline/state'
import { refreshActiveReads, stopActiveReads, resumeActiveReads } from '@/data/activeReads'
import { cancelApiReads } from '@/store/data/apiReads'
import { notePull } from '@/offline/freshness'
import { hasActiveMutations } from '@/offline/mutationGuard'
import { startSessionMaintenance, stopDomainRefresh, resumeDomainRefresh } from '@/offline/sync'
import { pullStaleCycle, scheduleWarmup, stopWarmup, resumeWarmup } from '@/offline/warmup'
import { backendReachability } from './state'
import { createRuntime } from './lifecycle'

export function createWebRuntime() {
  let alive = () => false
  let checking = false
  let checkAgain = false
  let connectionRevision = 0
  let cycling = false
  const canWork = () => alive() && !document.hidden && shouldAutoSync() && !isLoggedOut()
  async function checkConnection() {
    if (!alive()) return
    if (checking) { checkAgain = true; return }
    checking = true
    const revision = connectionRevision
    const wasOffline = isOffline.value
    try {
      // A superseded probe must not publish state before the revision check.
      const reachable = await probeBackend({ publish: false })
      if (!alive() || revision !== connectionRevision) return
      backendReachability.value = reachable ? 'reachable' : 'unreachable'
      isOffline.value = !reachable
      reconnectDeadline.value = reachable ? null : Date.now() + 60000
      if (reachable && wasOffline && canWork()) {
        if (alive() && !isOffline.value) scheduleWarmup()
      }
    } finally {
      checking = false
      if (checkAgain && alive()) {
        checkAgain = false
        void checkConnection().catch(() => {})
      }
    }
  }
  async function minute() {
    if (cycling || !canWork() || hasActiveMutations()) return
    cycling = true
    try {
      if (isOffline.value) await checkConnection()
      if (!canWork() || isOffline.value) return
      if (canWork() && !isOffline.value) {
        const refreshed = await pullStaleCycle()
        if (canWork() && !isOffline.value && !hasActiveMutations()) await refreshActiveReads()
        if (alive() && refreshed > 0) notePull()
      }
    } catch {
      // A failed refresh is retried by the next minute cycle.
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
      connectionRevision++
      checkAgain = false
      isOffline.value = true
      backendReachability.value = 'unreachable'
      reconnectDeadline.value = Date.now() + 60000
    }
    const online = () => { connectionRevision++; void checkConnection().catch(() => {}) }
    window.addEventListener('offline', offline)
    window.addEventListener('online', online)
    scope.onStop(() => {
      window.removeEventListener('offline', offline)
      window.removeEventListener('online', online)
      reconnectDeadline.value = null
    })
    const auth = useAuthStore()
    const canProbe = () => alive() && auth.isAuthenticated && !isLoggedOut()
    const heartbeat = window.setInterval(() => {
      if (canProbe() && (!isOffline.value || Date.now() >= (reconnectDeadline.value ?? 0))) void checkConnection().catch(() => {})
    }, 10000)
    const refresh = window.setInterval(() => void minute(), 60000)
    scope.onStop(() => { window.clearInterval(heartbeat); window.clearInterval(refresh) })
    scope.onStop(watch(() => [auth.isAuthenticated, auth.sessionMode] as const, () => {
      if (auth.isAuthenticated && auth.sessionMode === 'online' && canWork()) {
        void checkConnection().catch(() => {})
      }
    }))
    if (canWork()) void checkConnection().catch(() => {})
  }, checkConnection)
}
