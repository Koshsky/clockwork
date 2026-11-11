/**
 * Runtime configuration of the app.
 *
 * The full API URL is composed of the "server base address" (where the user
 * connects, e.g. https://localhost or https://erp.example.ru) plus the
 * /api/v1 suffix. By default it comes from VITE_API_URL (build), but can
 * be overridden at runtime (the pre-login settings screen / the sync
 * screen). The override is stored in localStorage (mvs_erp_api_url) and
 * survives reloads.
 *
 * Changing the address is only for the desktop (Electron) build. In the browser
 * version the SPA and the API live on the same origin (nginx proxy /api/v1),
 * the CSP «connect-src 'self'» blocks cross-origin, and the refresh cookie
 * (HttpOnly, SameSite=Strict) does not survive an origin change, so the web
 * override is ignored and not persisted (see also the server settings screen
 * and SystemSettingsPage).
 */

import { isElectron } from './electron'
import { t } from './i18n'

const API_URL_KEY = 'mvs_erp_api_url'

/** Constant suffix of the backend API endpoints. */
export const API_PREFIX = '/api/v1'

/** Current override (in memory) — to avoid reading localStorage on every request */
let override: string | null = null

// In the web build a stale override (e.g. left over from a desktop session in
// the same browser profile) must not affect the app — clear it right away.
if (!isElectron) {
  override = null
  try {
    localStorage.removeItem(API_URL_KEY)
  } catch {
    // no key — that's fine
  }
}

function isValidApiUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function readStored(): string | null {
  try {
    const raw = localStorage.getItem(API_URL_KEY)
    return raw && isValidApiUrl(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * Base API URL for API clients: runtime override, or env.
 * undefined — clients fall back to the built-in default themselves (as before).
 */
export function getApiUrl(): string | undefined {
  // Override (server change) — only in the desktop build; in the web the address
  // always comes from env (same-origin nginx proxy).
  const stored = isElectron ? (override ?? readStored()) : null
  if (stored) return stored.replace(/\/+$/, '')
  const env = import.meta.env.VITE_API_URL
  return env ? env.replace(/\/+$/, '') : undefined
}

/**
 * Base server address (without the /api/v1 suffix) to show in the settings field.
 * E.g. https://localhost / https://erp.example.ru.
 */
export function getServerBase(): string {
  const api = getApiUrl()
  if (!api) return ''
  // If the saved value already ends with /api/v1 — strip the suffix to show the
  // bare server base (e.g. https://host). String.prototype.replace treats the
  // pattern as a literal, so the regex anchor must be built explicitly.
  const base = api.endsWith(API_PREFIX) ? api.slice(0, -API_PREFIX.length) : api
  return base.replace(/\/+$/, '')
}

/**
 * Normalizes a user-entered server address into the full API URL:
 *  - strips trailing slashes and spaces;
 *  - appends /api/v1 if it is not there yet (so it does not depend on input).
 * Returns null if the address is not http(s)://host.
 */
export function normalizeServerToApiUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!isValidApiUrl(trimmed)) return null
  if (trimmed.endsWith(API_PREFIX)) return trimmed
  return `${trimmed}${API_PREFIX}`
}

/**
 * Sets the server address from a base input (auto-appends /api/v1).
 * persist=true saves to localStorage. Returns false for an invalid URL.
 */
export function setServerBase(input: string, persist: boolean): boolean {
  if (!isElectron) return false
  const full = normalizeServerToApiUrl(input)
  if (!full) return false
  return setApiUrl(full, persist)
}

/**
 * Sets the runtime API URL (full, already with /api/v1 when needed).
 * persist=true saves to localStorage; otherwise it lives only in session memory.
 * Returns false if the URL is invalid (not http(s)).
 */
export function setApiUrl(url: string, persist: boolean): boolean {
  if (!isElectron) return false
  const full = normalizeServerToApiUrl(url)
  if (!full) return false
  override = full
  try {
    if (persist) localStorage.setItem(API_URL_KEY, full)
    else localStorage.removeItem(API_URL_KEY)
  } catch {
    // settings are not critical — the in-memory override remains
  }
  return true
}

/** Resets the override — the app returns to VITE_API_URL */
export function resetApiUrl(): void {
  override = null
  try {
    localStorage.removeItem(API_URL_KEY)
  } catch {
    // ignore
  }
}

/** Whether a saved runtime URL exists (to show "override in use") */
export function hasApiUrlOverride(): boolean {
  return isElectron && Boolean(override ?? readStored())
}

/** Warning for an http scheme on a non-loopback host: the Secure refresh
 *  cookie is not stored/sent, so login and auto-sync may not work. For
 *  localhost/127.0.0.1 — null (local development). */
export function httpSchemeWarning(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return null
    const host = u.hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null
    return t('offline.http.insecureScheme')
  } catch {
    return null
  }
}
