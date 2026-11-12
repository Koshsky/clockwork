/**
 * Non-volatile refresh-token store (IndexedDB), shared by the web build and
 * the desktop (Electron) build.
 *
 * The refresh token is the single "remember me" mechanism, replacing the
 * desktop auto-sync password (safeStorage) that was removed. The token
 * returned by /auth/login and /auth/refresh is saved here in all
 * environments and sent in the body of /auth/refresh for silent session
 * renewal. Web falls back to the same-origin HttpOnly cookie when IndexedDB
 * is unavailable; desktop requires durable storage.
 *
 * The token is kept indefinitely — no TTL (see the no-TTL invariant in
 * db.ts): the refresh session itself expires server-side (168 h). The store is
 * written on every login/refresh rotation and cleared on logout.
 *
 * XSS-readable by design (same-origin JS can read IndexedDB): accepted
 * tradeoff — server-side rotation and reuse detection are the real protection.
 * The HttpOnly cookie exists only as a legacy fallback (see token.ts).
 */

import { idbPut, idbGet, idbDel } from './db'
import { platformCapabilities } from '@/platform/context'
import { localDataAvailability } from '@/platform/state'

const COOKIE_FALLBACK_KEY = 'mvs_erp_web_cookie_session'
function cookieFallback(): boolean {
  return platformCapabilities.optionalStorage && localStorage.getItem(COOKIE_FALLBACK_KEY) === '1'
}

function enableCookieFallback(error: unknown): void {
  if (!platformCapabilities.optionalStorage) throw error
  // Share the decision before releasing the refresh lock: another tab must not
  // replay the now-revoked token left in a failed IndexedDB rotation.
  localStorage.setItem(COOKIE_FALLBACK_KEY, '1')
}

/** IndexedDB object store holding the session row(s). */
export const SESSION_STORE = 'session'
/** Key of the row that holds the current refresh token. */
export const REFRESH_KEY = 'refresh'

/** Persist the refresh token (called on login and after each rotation). */
export async function saveRefreshToken(token: string): Promise<void> {
  if (cookieFallback()) return
  try { await idbPut(SESSION_STORE, REFRESH_KEY, token) } catch (error) { enableCookieFallback(error) }
}

/**
 * Read the stored refresh token, or null if none is saved (e.g. the store was
 * cleared or never written). A null result means the caller falls back to the
 * HttpOnly refresh cookie (legacy web path).
 */
export async function loadRefreshToken(): Promise<string | null> {
  if (cookieFallback()) return null
  try {
    const value = await idbGet<string>(SESSION_STORE, REFRESH_KEY)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch (error) {
    enableCookieFallback(error)
    return null
  }
}

/** Remove the stored refresh token (called on logout). */
export async function clearRefreshToken(): Promise<void> {
  if (platformCapabilities.optionalStorage && localDataAvailability.value === 'unavailable') return
  try { await idbDel(SESSION_STORE, REFRESH_KEY) } catch (error) { if (!platformCapabilities.optionalStorage) throw error }
}
