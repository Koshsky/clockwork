import { cacheGetFresh } from './cache'
import { replayOutboxToCache } from './outbox'
import { API_PREFIX } from '@/config'

/**
 * Local-first hydration: pages render ONLY from local data.
 *
 * Every render-facing store loader becomes "read from cache first, never hit
 * the network". The background PULL cycle (offline/cycle.ts) is the only thing
 * that issues GETs, refreshing these same cache entries. Cache misses leave
 * the state empty — the UI shows the "no local data" hint and the next PULL
 * (≤ cycle interval) fills it.
 *
 * Before reading, unsynced mutations are replayed on top of the cached
 * responses (write-through overlay) so offline edits never disappear.
 */

export interface HydrateTarget {
  /** Endpoint pathname, e.g. `/api/v1/project` */
  path: string
  /** Whether the local state is already filled (skip) */
  filled: () => boolean
  /** Apply the cached axios body ({ data, error } envelope) to the store */
  apply: (body: unknown) => void
  /**
   * Optional key filter for endpoints shared by several queries
   * (e.g. /user with role/limit params). Default — any key on the path.
   */
  keyPredicate?: (key: string) => boolean
}

export function apiPath(endpoint: string): string {
  return `${API_PREFIX}${endpoint}`
}

export async function hydrateFromCache(targets: HydrateTarget[]): Promise<void> {
  await replayOutboxToCache()
  for (const t of targets) {
    if (t.filled()) continue
    const entry = await cacheGetFresh<unknown>(t.path, t.keyPredicate)
    if (!entry) continue
    t.apply(entry.data)
  }
}