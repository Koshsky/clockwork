import { desktopSession, prepareDesktopSession } from '@/session/desktop'
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
    if (desktopSession) {
      const session = await prepareDesktopSession()
      if (!session.needsLogin && (session.mode === 'offline' || session.mode === 'online' && session.expiresAt <= Date.now())) await desktopSession.refresh()
    }
    await ensureCacheVersion()
    if (!scope.active()) return
    await initOfflineSync(scope.active)
    if (!scope.active()) return
    scope.onStop(startConnectionMonitor())
    if (!desktopSession) scope.onStop(startSessionMaintenance())
  }, retryConnectionNow)
}
