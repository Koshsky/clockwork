import { Configuration } from '@/api'
import { getApiUrl } from '@/config'
import { getAccessToken } from '@/token'
import { platformCapabilities } from '@/platform/context'
import { desktopSession } from '@/session/desktop'
import { isOffline } from '@/offline/state'
import { offlineFailFastAdapter } from '@/offline/failFast'

export function httpConfiguration(): Configuration {
  return new Configuration({
    basePath: getApiUrl(),
    baseOptions: {
      headers: { 'Content-Type': 'application/json' }, timeout: 10000,
      ...(platformCapabilities.kind !== 'web' && !desktopSession && isOffline.value ? { adapter: offlineFailFastAdapter } : {}),
    },
    apiKey: () => `Bearer ${getAccessToken()}`,
  })
}
