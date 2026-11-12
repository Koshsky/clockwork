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
    await ensureCacheVersion()
    if (!scope.active()) return
    await initOfflineSync(scope.active)
    if (!scope.active()) return
    scope.onStop(startConnectionMonitor())
    scope.onStop(startSessionMaintenance())
  }, retryConnectionNow)
}
