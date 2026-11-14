/** Legacy desktop token helpers; web sessions use the HttpOnly cookie exclusively. */

import { idbPut, idbGet, idbDel } from './db'
import { platformCapabilities } from '@/platform/context'
/** IndexedDB object store holding the session row(s). */
export const SESSION_STORE = 'session'
/** Key of the row that holds the current refresh token. */
export const REFRESH_KEY = 'refresh'

/** Persist the refresh token (called on login and after each rotation). */
export async function saveRefreshToken(token: string): Promise<void> {
  if (platformCapabilities.optionalStorage) return
  await idbPut(SESSION_STORE, REFRESH_KEY, token)
}

/**
 * Read the stored refresh token, or null if none is saved (e.g. the store was
 * cleared or never written). A null result means the caller falls back to the
 * HttpOnly refresh cookie (legacy web path).
 */
export async function loadRefreshToken(): Promise<string | null> {
  if (platformCapabilities.optionalStorage) return null
  const value = await idbGet<string>(SESSION_STORE, REFRESH_KEY)
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Remove the stored refresh token (called on logout). */
export async function clearRefreshToken(): Promise<void> {
  if (platformCapabilities.optionalStorage) return
  await idbDel(SESSION_STORE, REFRESH_KEY)
}
