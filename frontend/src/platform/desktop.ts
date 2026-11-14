import { watch } from 'vue'
import { autoSync, warmupEnabled } from '@/settings'
import { desktopSessionState } from '@/session/desktop'
import { desktopSession, prepareDesktopSession } from '@/session/desktop'
import { refreshPendingCount, nativeQueueChanged } from '@/offline/nativeEvents'
import { localDataAvailability } from './state'
import { nativeQueue, nativeSync, queueRequest } from '@/offline/desktopQueue'
import { ensureCacheVersion } from '@/offline/cache'
import { initOfflineSync, startSessionMaintenance, stopDomainRefresh, resumeDomainRefresh } from '@/offline/sync'
import { startConnectionMonitor, retryConnectionNow } from '@/offline/connection'
import { stopWarmup, resumeWarmup } from '@/offline/warmup'
import { createRuntime } from './lifecycle'

export function createDesktopRuntime() {
  return createRuntime('desktop', async scope => {
    resumeWarmup()
    resumeDomainRefresh()
    scope.onStop(stopWarmup)
    scope.onStop(stopDomainRefresh)
    if (nativeQueue) {
      const state = await window.erpDesktop!.service!.status()
      localDataAvailability.value = state.storage?.phase === 'ready' ? 'available' : 'unavailable'
    }
    if (desktopSession) {
      const session = await prepareDesktopSession()
      if (nativeQueue && session.user && session.mode !== 'signedOut') await queueRequest({ action: 'configure', autoSync: autoSync.value })
      if (!session.needsLogin && (session.mode === 'offline' || session.mode === 'online' && session.expiresAt <= Date.now())) await desktopSession.refresh()
    }
    if (nativeQueue) {
      scope.onStop(nativeQueueChanged())
      scope.onStop(watch([autoSync, () => desktopSessionState.value?.contextId], () => {
        const state = desktopSessionState.value
        if (state?.user && state.mode !== 'signedOut') void queueRequest({ action: 'configure', autoSync: autoSync.value }).catch(() => {})
      }))
      const settingsChanged = (event: StorageEvent) => { if (event.key === 'mvs_erp_auto_sync' && event.newValue != null) autoSync.value = event.newValue === '1' }
      window.addEventListener('storage', settingsChanged)
      scope.onStop(() => window.removeEventListener('storage', settingsChanged))
      if (nativeSync) {
        const names = ['permissions', 'profile', 'projects', 'users', 'resources', 'members', 'assignments', 'myStaff', 'project-plan', 'process-plan', 'task-plan', 'states', 'employees', 'periods', 'calendar']
        scope.onStop(watch(() => [desktopSessionState.value?.contextId, ...names.map(name => warmupEnabled[name])], () => {
          const state = desktopSessionState.value
          if (state?.user && state.mode !== 'signedOut') void queueRequest({ action: 'syncConfigure', enabled: Object.fromEntries(names.map(name => [name, warmupEnabled[name]])) }).catch(() => {})
        }, { immediate: true }))
      }
      await refreshPendingCount()
    } else await ensureCacheVersion()
    if (!scope.active()) return
    if (nativeSync) return
    await initOfflineSync(scope.active)
    if (!scope.active()) return
    scope.onStop(startConnectionMonitor())
    if (!desktopSession) scope.onStop(startSessionMaintenance())
  }, retryConnectionNow)
}
