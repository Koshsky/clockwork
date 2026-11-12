import { UsersApi, type Configuration } from '@/api'
import { readApi } from './apiReads'
import { readConfiguration } from './readConfiguration'

export function loadStructure(configuration: () => Configuration, signal?: AbortSignal) {
  return readApi('account.structure', undefined,
    request => new UsersApi(readConfiguration(configuration)).userStructureGet(request), false, signal)
}

export async function loadAppManifest(): Promise<{ version?: string } | null> {
  const response = await fetch('/precache-manifest.json', { signal: AbortSignal.timeout(5000) })
  return response.ok ? await response.json() : null
}

export async function probeServerLogin(base: string | undefined): Promise<boolean> {
  if (!base) return false
  try {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'probe' }), signal: AbortSignal.timeout(5000),
    })
    return response.status < 500
  } catch { return false }
}
