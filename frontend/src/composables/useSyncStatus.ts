import { computed, ref } from 'vue'
import { isOffline } from '../offline/state'
import { pendingCount } from '../offline/outbox'
import { lastPullAt } from '../offline/connection'
import { t } from '../i18n'

/**
 * Shared sync/freshness status: how long ago the background PULL last updated
 * the cache, pending queue size and the offline flag. Works in every
 * environment (web + desktop).
 *
 * A single module-level clock (started by the first consumer, app-lifetime)
 * advances `now`, so the relative freshness label keeps ticking even when
 * `lastPullAt` changes rarely (all domains within their TTL). No per-consumer
 * intervals — MainLayout and AppHeader share one timer.
 */

const CLOCK_TICK_MS = 30_000

const now = ref(Date.now())
let clockStarted = false
function ensureClock(): void {
  if (clockStarted || typeof window === 'undefined') return
  clockStarted = true
  window.setInterval(() => {
    now.value = Date.now()
  }, CLOCK_TICK_MS)
}

export function useSyncStatus() {
  ensureClock()

  const offline = computed(() => isOffline.value)
  const pending = computed(() => pendingCount.value)

  // Data freshness: how long ago the background PULL last updated the cache
  const lastPullLabel = computed(() => {
    const ts = lastPullAt.value
    if (ts == null) return null
    const s = Math.max(0, Math.round((now.value - ts) / 1000))
    if (s < 60) return t('dates.seconds', { n: s })
    const m = Math.round(s / 60)
    if (m < 60) return t('dates.minutes', { n: m })
    const h = Math.round(m / 60)
    return t('dates.hours', { n: h })
  })

  return { offline, pending, lastPullLabel }
}