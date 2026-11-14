import { desktopSession, prepareDesktopSession } from '@/session/desktop'
import { ref } from 'vue'
import type { Ref } from 'vue'
import { getApiUrl } from '@/config'
import { backendReachability } from '@/platform/state'

/**
 * Reactive backend-connection state, active in EVERY environment (web and
 * desktop). It drives the offline UI (the reconnect toast) and the shared
 * `isOffline` flag that other offline modules read.
 *
 * The flag is initialised from the browser's `navigator.onLine` and kept in
 * sync with the window `online`/`offline` events (both fire in the browser and
 * under Electron). The authoritative reachability of the backend is decided by
 * `probeBackend()`/the connection monitor (offline/connection.ts) which flips
 * this flag on every probe.
 */
export const isOffline: Ref<boolean> = ref(
  typeof navigator !== 'undefined' && navigator.onLine === false,
)

const PROBE_TIMEOUT_MS = 4000

/** Liveness probe URL: the real backend endpoint /api/v1/health. */
function probeUrl(): string | null {
  const base = getApiUrl()
  return base ? `${base.replace(/\/+$/, '')}/health` : null
}

/** Whether the backend is alive: any status <500 = reachable, network error/5xx = not */
export async function probeBackend({ publish = true }: { publish?: boolean } = {}): Promise<boolean> {
  if (desktopSession) {
    try {
      await prepareDesktopSession()
      const reachable = await desktopSession.probe()
      if (publish) backendReachability.value = reachable ? 'reachable' : 'unreachable'
      return reachable
    } catch { if (publish) backendReachability.value = 'unreachable'; return false }
  }
  const url = probeUrl()
  if (!url) return false
  try {
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
      if (publish) backendReachability.value = res.status < 500 ? 'reachable' : 'unreachable'
      return res.status < 500
    } finally {
      window.clearTimeout(timer)
    }
  } catch {
    if (publish) backendReachability.value = 'unreachable'
    return false
  }
}

/**
 * Epoch ms of the next automatic reconnect probe while offline. `null` means
 * not offline (no probe is being awaited) or the monitor is not running the
 * reconnect countdown yet.
 *
 * A wall-clock deadline (instead of a decrementing counter) keeps the
 * countdown honest: background tabs throttle window timers, so a counter that
 * only decreases on ticks freezes while the tab is hidden, and the UI showed a
 * stuck "reconnect in 60 s". Reconnect happens at the deadline regardless.
 */
export const reconnectDeadline = ref<number | null>(null)
