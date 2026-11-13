import { watch } from 'vue'
import { autoSync } from '@/settings'
import { desktopSessionState } from '@/session/desktop'
import { desktopSession, prepareDesktopSession } from '@/session/desktop'
import { refreshPendingCount, nativeQueueChanged } from '@/offline/nativeEvents'
import { localDataAvailability } from './state'
import { nativeQueue, queueRequest } from '@/offline/desktopQueue'
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
      await refreshPendingCount()
    } else await ensureCacheVersion()
    if (!scope.active()) return
    await initOfflineSync(scope.active)
    if (!scope.active()) return
    scope.onStop(startConnectionMonitor())
    if (!desktopSession) scope.onStop(startSessionMaintenance())
  }, retryConnectionNow)
}
