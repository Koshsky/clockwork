/**
 * "Logged out" flag (localStorage): after an explicit logout, auto-sync
 * (silent re-login and login at startup) does not run until the user
 * logs in manually online. Offline login via the button (LoginPage) is an
 * explicit user action and does not touch the flag.
 */

const LOGGED_OUT_KEY = 'mvs_erp_logged_out'

/** Whether the "user logged out and has not logged in manually yet" flag is set */
export function isLoggedOut(): boolean {
  try {
    return localStorage.getItem(LOGGED_OUT_KEY) === '1'
  } catch {
    return false
  }
}

/** Clear the flag — only on a successful manual online login */
export function clearLoggedOut(): void {
  try {
    localStorage.removeItem(LOGGED_OUT_KEY)
  } catch {
    // flag is not critical
  }
}

/** Set the flag — on explicit logout */
export function setLoggedOut(): void {
  try {
    localStorage.setItem(LOGGED_OUT_KEY, '1')
  } catch {
    // flag is not critical
  }
}