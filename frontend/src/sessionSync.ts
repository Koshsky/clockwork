/**
 * Cross-tab session coordination for the web build and the desktop build.
 *
 * The access token lives only in memory (per tab, see token.ts), while the
 * refresh token is now shared state that every tab keeps in the non-volatile
 * IndexedDB 'session' store (see offline/session.ts) and sends in the body of
 * /auth/refresh. On web it may additionally fall back to the legacy HttpOnly
 * cookie when no stored refresh exists.
 *
 * The backend rotates the refresh session on every /auth/refresh, and
 * presenting an already-rotated (revoked) token is treated as theft: ALL of
 * the user's sessions are revoked. Two tabs refreshing at the same time
 * therefore race: the first rotates the shared refresh, the second sends the
 * old token, triggers the family revocation — and every tab is kicked to
 * /login with "Session expired".
 *
 * This module adds a cross-tab mutex around the refresh (only one tab calls
 * /auth/refresh at a time) and broadcasts the freshly issued session (access
 * token + rotated refresh token) to the sibling tabs, so they adopt both
 * without their own refresh request. Cross-tab coordination applies to every
 * environment (web + desktop windows).
 */

const LOCK_KEY = 'mvs_erp_refresh_lock'
/** Legacy access-token broadcast key (plain string) — kept for compatibility. */
const TOKEN_BROADCAST_KEY = 'mvs_erp_session_token'
/** Session broadcast key (access + refresh) — JSON payload. */
const SESSION_BROADCAST_KEY = 'mvs_erp_session_state'
/** How long a refresh lock stays valid (a tab may die while holding it) */
const LOCK_TTL_MS = 15_000
const CHANNEL_NAME = 'mvs_erp_session'

/** Unique id of this tab (refresh lock owner and broadcast source) */
export const REFRESH_OWNER: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

let channel: BroadcastChannel | null = null
if (typeof BroadcastChannel !== 'undefined') {
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
  } catch {
    channel = null
  }
}

interface RefreshLock {
  owner: string
  ts: number
}

function readLock(): RefreshLock | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    const value = raw ? JSON.parse(raw) as Partial<RefreshLock> : null
    return value && typeof value.owner === 'string' && typeof value.ts === 'number' && Number.isFinite(value.ts)
      ? value as RefreshLock
      : null
  } catch {
    return null
  }
}

/** Claim the cross-tab refresh lock; false — another tab is refreshing right now */
export function tryAcquireRefreshLock(): boolean {
  const now = Date.now()
  const lock = readLock()
  if (lock && now >= lock.ts && now - lock.ts < LOCK_TTL_MS && lock.owner !== REFRESH_OWNER) {
    return false
  }
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: REFRESH_OWNER, ts: now }))
  } catch {
    // localStorage unavailable — fall back to uncoordinated refresh
  }
  return true
}

/** Release the refresh lock if it belongs to this tab */
export function releaseRefreshLock(): void {
  const lock = readLock()
  if (lock && lock.owner === REFRESH_OWNER) {
    try {
      localStorage.removeItem(LOCK_KEY)
    } catch {
      // ignore — the lock expires via TTL
    }
  }
}

/** Web Locks makes acquisition atomic; the storage lock also coordinates older clients. */
export async function withRefreshLock(refresh: () => Promise<boolean>): Promise<boolean | null> {
  const run = async () => {
    if (!tryAcquireRefreshLock()) return null
    try {
      return await refresh()
    } finally {
      releaseRefreshLock()
    }
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('mvs_erp_refresh', { ifAvailable: true }, lock => lock ? run() : null)
  }
  return run()
}

/** Session payload broadcast to sibling tabs (access + rotated refresh) */
export interface SessionPayload {
  access?: string
  refresh?: string
}

/**
 * Publish a complete session (access token + rotated refresh token) to sibling
 * tabs after a refresh. BroadcastChannel first; the localStorage writes double
 * as a fallback ("storage" fires in other tabs). The legacy access-only key is
 * mirrored so older token-only subscribers still hear the rotation.
 */
export function publishSession(payload: SessionPayload): void {
  const { access, refresh } = payload
  try {
    channel?.postMessage({ type: 'session', access, refresh })
    localStorage.setItem(
      SESSION_BROADCAST_KEY,
      JSON.stringify({ access: access ?? null, refresh: refresh ?? null }),
    )
    if (typeof access === 'string') {
      // Mirror the access token to the legacy key for token-only compatibility.
      localStorage.setItem(TOKEN_BROADCAST_KEY, access)
    }
  } catch {
    // ignore
  }
}

/**
 * Subscribe to whole-session messages (access + refresh) published by sibling
 * tabs; returns an unsubscribe. The refresh lets every tab keep its IndexedDB
 * store up to date with the rotation.
 */
export function subscribeSession(cb: (payload: SessionPayload) => void): () => void {
  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as { type?: string; access?: string; refresh?: string } | undefined
    if (
      data?.type === 'session' &&
      (typeof data.access === 'string' || typeof data.refresh === 'string')
    ) {
      cb({ access: data.access, refresh: data.refresh })
    }
  }
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === SESSION_BROADCAST_KEY && typeof ev.newValue === 'string') {
      try {
        const parsed = JSON.parse(ev.newValue) as { access?: string; refresh?: string }
        if (parsed.access != null || parsed.refresh != null) {
          cb({ access: parsed.access, refresh: parsed.refresh })
        }
      } catch {
        // malformed fallback payload — ignore
      }
    }
  }
  channel?.addEventListener('message', onMessage)
  window.addEventListener('storage', onStorage)
  return () => {
    channel?.removeEventListener('message', onMessage)
    window.removeEventListener('storage', onStorage)
  }
}

/** Publish a freshly issued access token to sibling tabs (legacy, access only) */
export function publishToken(token: string): void {
  publishSession({ access: token })
}

/**
 * Subscribe to access-token messages published by sibling tabs; returns an
 * unsubscribe. Thin wrapper over the session channel: only the access token is
 * forwarded, so callers that only need the token (e.g. adopting a rotated
 * access token) keep working unchanged.
 */
export function subscribeToken(cb: (token: string) => void): () => void {
  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as { type?: string; token?: string; access?: string } | undefined
    if (data?.type === 'session' && typeof data.access === 'string') cb(data.access)
    else if (data?.type === 'token' && typeof data.token === 'string') cb(data.token)
  }
  const onStorage = (ev: StorageEvent) => {
    if (ev.key === TOKEN_BROADCAST_KEY && typeof ev.newValue === 'string') cb(ev.newValue)
    else if (ev.key === SESSION_BROADCAST_KEY && typeof ev.newValue === 'string') {
      try {
        const parsed = JSON.parse(ev.newValue) as { access?: string }
        if (typeof parsed.access === 'string') cb(parsed.access)
      } catch {
        // malformed fallback payload — ignore
      }
    }
  }
  channel?.addEventListener('message', onMessage)
  window.addEventListener('storage', onStorage)
  return () => {
    channel?.removeEventListener('message', onMessage)
    window.removeEventListener('storage', onStorage)
  }
}