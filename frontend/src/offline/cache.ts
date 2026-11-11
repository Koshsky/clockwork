import { idbClear, idbGet, idbKeys, idbPut } from './db'

const CACHE_STORE = 'cache'
/** Marker entry storing the app version the current cache was written with */
const VERSION_KEY = 'meta:app-version'

/**
 * Per-user namespacing of the GET cache. The cache key is the full request URL
 * (see http.ts cacheKey) and the Authorization token lives in a header, so
 * without a user prefix the scoped responses of different accounts would share
 * one key and the last writer would win — the next account would hydrate
 * someone else's data (e.g. the timesheet roster of the previous admin). The
 * prefix is `u<userId>:`, using the same localStorage key the auth store
 * bootstraps the current user from. When the user is not known yet (boot,
 * logged out) only unprefixed keys are served — never another user's entries.
 */

/** localStorage key of the current user (mirrors user/USER_KEY in store) */
const USER_KEY = 'mvs_erp_user'

const USER_PREFIX_RE = /^u\d+:/

/** Current user id from localStorage (null — not known yet / logged out). */
export function currentUserId(): number | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { id?: unknown } | null
    return typeof parsed?.id === 'number' ? parsed.id : null
  } catch {
    return null
  }
}

/** Prefix of the current user's cache keys (`u<id>:`, '' when unknown). */
export function userCachePrefix(): string {
  const id = currentUserId()
  return id != null ? userKeyOf('', id) : ''
}

/** Pure helpers (unit-tested without IndexedDB). */

/** Cache key of a URL for a user: `u<userId>:` + url. */
export function userKeyOf(url: string, userId: number): string {
  return `u${userId}:${url}`
}

/** Removes a user prefix, if any (so URL parsing sees the plain url). */
export function stripUserPrefix(key: string): string {
  return key.replace(USER_PREFIX_RE, '')
}

/** Whether a key belongs to the given user: its `u<id>:` prefix must match.
 *  With an unknown user (null) only keys WITHOUT a user prefix are served —
 *  foreign user entries are never readable. */
export function keyMatchesUser(key: string, userId: number | null): boolean {
  const m = key.match(USER_PREFIX_RE)
  if (userId == null) return !m
  return m != null && `u${userId}:` === m[0]
}

/**
 * Cache of API responses in IndexedDB. The key is the full URL of the GET
 * request (axios.getUri).
 *
 * Rendering is LOCAL-FIRST: pages always read the cache (via hydrateFromCache),
 * and the network is used only by the background PULL cycle (which writes fresh
 * responses here) and by mutations. No TTL is enforced on reads — stale data
 * is better than nothing; freshness is surfaced in the UI (cacheGetFresh).
 *
 * NO-TTL: entries are never removed by age or timers. The `ts` timestamp is
 * stored solely to surface freshness in the UI and to let the PULL cycle decide
 * whether a background re-fetch is worthwhile (PULL_TTL_MS) — it is never used
 * to delete data. The cache as a whole is cleared only on an app-version change
 * (ensureCacheVersion).
 * See docs/no-ttl-local-storage.md.
 */

export interface CachedEntry<T> {
  ts: number
  /** App version the entry was written by (for cache invalidation on upgrade) */
  version?: string
  data: T
}

/** The app version at runtime (vite define, also in main.ts) */
function appVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
}

export async function cachePut<T>(key: string, data: T): Promise<void> {
  try {
    const entry: CachedEntry<T> = { ts: Date.now(), version: appVersion(), data }
    await idbPut(CACHE_STORE, key, entry)
  } catch {
    // The cache is not a critical layer: write errors are ignored
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const entry = await idbGet<CachedEntry<T>>(CACHE_STORE, key)
    return entry?.data ?? null
  } catch {
    return null
  }
}

function pathnameOf(key: string): string | null {
  const plain = stripUserPrefix(key)
  try {
    return new URL(plain).pathname
  } catch {
    // relative key (no base) — take everything up to '?', as in cacheApply
    return plain.split('?')[0]
  }
}

/**
 * Returns the freshest cached response by pathname (endpoint), ignoring
 * query parameters. Needed for GETs with date windows (calendar, timesheet, absences)
 * whose full URL depends on "today" and after replay differs from the
 * warmed one: the exact key does not match, but the endpoint data is in the cache.
 *
 * `keyPredicate` narrows the match when the same pathname is shared by several
 * queries (e.g. /user with different role/limit params): only keys satisfying
 * it are considered.
 */
export async function cacheGetByPath<T>(
  pathname: string,
  keyPredicate?: (key: string) => boolean,
): Promise<T | null> {
  try {
    const keys = await idbKeys(CACHE_STORE)
    const userId = currentUserId()
    let best: { ts: number; data: T } | null = null
    for (const key of keys) {
      // Never serve another user's cached responses (per-user key prefix).
      if (!keyMatchesUser(key, userId)) continue
      if (pathnameOf(key) !== pathname) continue
      if (keyPredicate && !keyPredicate(key)) continue
      const entry = await idbGet<CachedEntry<T>>(CACHE_STORE, key)
      if (!entry) continue
      if (!best || entry.ts > best.ts) best = { ts: entry.ts, data: entry.data }
    }
    return best ? best.data : null
  } catch {
    return null
  }
}

/** Cached value together with its write time (for the freshness UX) */
export interface FreshEntry<T> {
  data: T
  /** Write time (epoch ms). For UI freshness only — never used to delete data. */
  ts: number
}

/**
 * All cached responses for a pathname (keys, write times and bodies), oldest
 * first. Used to merge paginated list pages offline (each visited page is
 * cached write-through by http.ts under its own key with its offset param).
 * Falls back to [] on any IDB error — the caller treats it as "no cache".
 */
export async function cacheGetAllByPath<T>(
  pathname: string,
  keyPredicate?: (key: string) => boolean,
): Promise<Array<{ key: string; ts: number; data: T }>> {
  try {
    const keys = await idbKeys(CACHE_STORE)
    const userId = currentUserId()
    const out: Array<{ key: string; ts: number; data: T }> = []
    for (const key of keys) {
      if (!keyMatchesUser(key, userId)) continue
      if (pathnameOf(key) !== pathname) continue
      if (keyPredicate && !keyPredicate(key)) continue
      const entry = await idbGet<CachedEntry<T>>(CACHE_STORE, key)
      if (!entry) continue
      out.push({ key, ts: entry.ts, data: entry.data })
    }
    return out.sort((a, b) => a.ts - b.ts)
  } catch {
    return []
  }
}

/**
 * The freshest cached response for a pathname together with its write time.
 * `ts` is exposed purely for UI/cycle freshness (e.g. "cached X ago", PULL
 * staleness gating); reading it never deletes or evicts an entry — the cache
 * has no TTL (see file header).
 */

export async function cacheGetFresh<T>(
  pathname: string,
  keyPredicate?: (key: string) => boolean,
): Promise<FreshEntry<T> | null> {
  try {
    const keys = await idbKeys(CACHE_STORE)
    const userId = currentUserId()
    let best: FreshEntry<T> | null = null
    for (const key of keys) {
      if (!keyMatchesUser(key, userId)) continue
      if (pathnameOf(key) !== pathname) continue
      if (keyPredicate && !keyPredicate(key)) continue
      const entry = await idbGet<CachedEntry<T>>(CACHE_STORE, key)
      if (!entry) continue
      if (!best || entry.ts > best.ts) best = { data: entry.data, ts: entry.ts }
    }
    return best
  } catch {
    return null
  }
}

/**
 * Clears the GET cache when the app version changed (format/schema of cached
 * payloads may differ between releases). The mutation queue (outbox) is NOT
 * touched — unsynced changes must never be lost. Called at desktop startup.
 */
export async function ensureCacheVersion(): Promise<void> {
  const version = appVersion()
  if (!version) return
  try {
    const stored = await idbGet<{ v: string }>(CACHE_STORE, VERSION_KEY)
    if (stored && stored.v === version) return
    await idbClear(CACHE_STORE)
    await idbPut(CACHE_STORE, VERSION_KEY, { v: version })
  } catch {
    // cache is not critical — ignore
  }
}