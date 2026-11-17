import { createApplicationServices } from './applicationClients'
import { desktopSession, prepareDesktopSession } from '@/session/desktop'
import { type Configuration, type ReleaseInfo } from '@/api'
import { isOffline } from '@/offline/state'
import { readApi } from './apiReads'
import { readConfiguration } from './readConfiguration'

export function loadStructure(configuration: () => Configuration, signal?: AbortSignal) {
  const applicationServices = createApplicationServices(configuration, () => readConfiguration(configuration))
  return readApi('account.structure', undefined,
    request => applicationServices.users.structure(request), false, signal)
}

export async function loadAppManifest(): Promise<{ version?: string } | null> {
  const response = await fetch('/precache-manifest.json', { signal: AbortSignal.timeout(5000) })
  return response.ok ? await response.json() : null
}

export async function loadBackendInfo(signal?: AbortSignal): Promise<ReleaseInfo | null> {
  const applicationServices = createApplicationServices()
  const deadline = new AbortController()
  // An unresponsive native bridge must not retain the page's read indefinitely.
  const timer = setTimeout(() => deadline.abort(new DOMException('Backend metadata request timed out', 'TimeoutError')), 10000)
  try {
    const response = await readApi('application.info', undefined,
      request => applicationServices.application.info(request), isOffline.value,
      signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal)
    return response.data?.data ?? null
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) throw deadline.signal.reason
    throw error
  } finally { clearTimeout(timer) }
}

export async function probeServerLogin(base: string | undefined): Promise<boolean> {
  if (desktopSession) {
    try { await prepareDesktopSession(); return await desktopSession.probe() } catch { return false }
  }
  if (!base) return false
  try {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'probe' }), signal: AbortSignal.timeout(5000),
    })
    return response.status < 500
  } catch { return false }
}
