/**
 * Electron integration for the frontend.
 *
 * In the desktop wrapper (services/desktop) the renderer gets the
 * `window.erpDesktop` bridge via preload. This module detects the environment
 * and exposes the desktop app version. The safeStorage password API (autosync)
 * was removed: session renewal now uses the unified refresh token stored in
 * IndexedDB (see offline/session.ts) in every environment.
 */

export const isElectron = Boolean(
  typeof window !== 'undefined' && window.erpDesktop?.isElectron === true,
)

/** Desktop app version (Electron), or null in the browser */
export async function desktopAppVersion(): Promise<{ version: string; electron: string } | null> {
  if (!isElectron || !window.erpDesktop) return null
  try {
    return await window.erpDesktop.appVersion()
  } catch {
    return null
  }
}
