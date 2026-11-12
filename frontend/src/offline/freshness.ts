import { ref } from 'vue'

const LAST_PULL_KEY = 'mvs_erp_last_pull_at'

function readLastPull(): number | null {
  try {
    const raw = localStorage.getItem(LAST_PULL_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Time of the last successful background PULL (for the freshness chip) */
export const lastPullAt = ref<number | null>(readLastPull())

export function notePull(): void {
  const now = Date.now()
  lastPullAt.value = now
  try {
    localStorage.setItem(LAST_PULL_KEY, String(now))
  } catch {
    // not critical
  }
}
