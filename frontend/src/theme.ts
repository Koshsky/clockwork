import { computed, ref } from 'vue'

/**
 * App color scheme (light / dark / system).
 * Persisted in localStorage under mvs_erp_theme_scheme and applied as
 * `data-scheme` on <html> (see src/styles/tokens.css). Defaults to the
 * OS preference. Module-scoped like settings.ts — no store needed.
 */

export type ThemeScheme = 'light' | 'dark' | 'system'

const THEME_KEY = 'mvs_erp_theme_scheme'

const media = window.matchMedia('(prefers-color-scheme: dark)')

function readScheme(): ThemeScheme {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // storage unavailable — fall through to system
  }
  return 'system'
}

/** The scheme the user picked (may be 'system') */
export const scheme = ref<ThemeScheme>(readScheme())

/** Resolved scheme actually shown to the user */
export const resolvedScheme = computed<'light' | 'dark'>(() =>
  scheme.value === 'system' ? (media.matches ? 'dark' : 'light') : scheme.value,
)

function apply(): void {
  document.documentElement.dataset.scheme = resolvedScheme.value
}

export function setScheme(s: ThemeScheme): void {
  scheme.value = s
  try {
    localStorage.setItem(THEME_KEY, s)
  } catch {
    // persistence is not critical
  }
  apply()
}

/** Switch between the two visible schemes (system resolves first) */
export function toggleScheme(): void {
  setScheme(resolvedScheme.value === 'dark' ? 'light' : 'dark')
}

/** Call once on app bootstrap: applies the scheme and tracks the OS theme */
export function initTheme(): void {
  apply()
  const onChange = (): void => {
    if (scheme.value === 'system') apply()
  }
  media.addEventListener('change', onChange)
}