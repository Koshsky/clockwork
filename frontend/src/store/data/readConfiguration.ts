import { Configuration } from '@/api'
import axios from 'axios'
import { getApiUrl } from '@/config'
import { getAccessToken } from '@/token'
import { platformCapabilities } from '@/platform/context'
import type { Configuration as ApiConfiguration } from '@/api'

export function readConfiguration(configuration: () => ApiConfiguration): ApiConfiguration {
  const existing = configuration()
  if (platformCapabilities.kind !== 'web') return existing
  // Reachability is a hint, not a reason to prevent an explicit online read.
  return new Configuration({
    ...existing,
    basePath: getApiUrl(),
    apiKey: () => `Bearer ${getAccessToken()}`,
    baseOptions: { ...existing.baseOptions, adapter: axios.defaults.adapter },
  })
}
