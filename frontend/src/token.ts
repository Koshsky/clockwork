/**
 * In-memory access token (AD-05): the access token lives only in process memory,
 * NOT in localStorage (XSS cannot read it). After a page reload the session is
 * restored via /auth/refresh: the refresh token is read from the IndexedDB
 * session store (offline/session.ts, shared by web and desktop) and sent in the
 * request body; the HttpOnly cookie is only a legacy fallback when no stored
 * token exists. IndexedDB is XSS-readable by design — server-side rotation and
 * reuse detection are the real protection (see docs/no-ttl-local-storage.md).
 */
let accessToken: string | null = null

export function getAccessToken(): string {
  return accessToken ?? ''
}

export function setAccessToken(token: string | null): void {
  accessToken = token
}