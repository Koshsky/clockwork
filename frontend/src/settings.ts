import { reactive, ref, watch } from 'vue'
import type { PlanningUnit } from './components/planner/calendar'
import { LINK_STYLE_DEFAULT, normalizeLinkStyle, type LinkStyle } from './components/planner/linkStyle'

/**
 * Sync settings (the "Sync" screen). Stored in localStorage
 * under the mvs_erp_sync_* keys. Login/password are not stored here: the session
 * lives in the access token (in memory, AD-05) and the refresh token (IndexedDB,
 * offline/session.ts — sent in the body of /auth/refresh; the HttpOnly cookie is
 * only a legacy fallback). After a reload, restoration happens via /auth/refresh.
 */

const AUTO_SYNC_KEY = 'mvs_erp_auto_sync'

// --- Interface language ------------------------------------------------------

export type UiLanguage = 'auto' | 'ru' | 'en'

const UI_LANG_KEY = 'mvs_erp_ui_lang'

function readUiLanguage(): UiLanguage {
  try {
    const raw = localStorage.getItem(UI_LANG_KEY)
    return raw === 'ru' || raw === 'en' || raw === 'auto' ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

/** Interface language setting: 'auto' — follow the browser language. */
export const uiLanguage = ref<UiLanguage>(readUiLanguage())

watch(
  uiLanguage,
  (v) => {
    try {
      localStorage.setItem(UI_LANG_KEY, v)
    } catch {
      // not critical
    }
  },
  { immediate: true },
)

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

/** Auto-sync: PUSH at startup and when the network returns */
export const autoSync = ref(readBool(AUTO_SYNC_KEY, true))

/** Saves the current setting values to localStorage */
export function saveSyncSettings(): void {
  try {
    localStorage.setItem(AUTO_SYNC_KEY, autoSync.value ? '1' : '0')
  } catch {
    // settings are not critical
  }
}

/** Reactive auto-sync check (for sync.ts, read on the fly) */
export function shouldAutoSync(): boolean {
  return autoSync.value
}

// ---------------------------------------------------------------------------
// Notification stack settings (the "Notifications" card on the Settings page).
// Per-device, localStorage, applied by notify/state.ts and the host.
// ---------------------------------------------------------------------------

const NOTIFY_ENABLED_KEY = 'mvs_erp_notifications_enabled'
const NOTIFY_DURATION_KEY = 'mvs_erp_notification_duration'

/** Show the global notification stack at all (default: yes). */
export const notificationsEnabled = ref(readBool(NOTIFY_ENABLED_KEY, true))

/** Auto-hide duration options (ms); 0 = never auto-hide. */
export const NOTIFY_DURATION_OPTIONS = [3000, 5000, 8000, 10000] as const

export type NotifyDuration = (typeof NOTIFY_DURATION_OPTIONS)[number] | 0

function readDuration(key: string): NotifyDuration {
  try {
    const n = Number(localStorage.getItem(key))
    return NOTIFY_DURATION_OPTIONS.includes(n as (typeof NOTIFY_DURATION_OPTIONS)[number]) || n === 0
      ? (n as NotifyDuration)
      : 5000
  } catch {
    return 5000
  }
}

/** Default auto-dismiss time for notifications (default: 5 s). */
export const notifyDurationMs = ref<NotifyDuration>(readDuration(NOTIFY_DURATION_KEY))

/** Persists the notification settings to localStorage. */
export function saveNotifySettings(): void {
  try {
    localStorage.setItem(NOTIFY_ENABLED_KEY, notificationsEnabled.value ? '1' : '0')
    localStorage.setItem(NOTIFY_DURATION_KEY, String(notifyDurationMs.value))
  } catch {
    // settings are not critical
  }
}

// ---------------------------------------------------------------------------
// Per-domain warm-up toggles ("Какие данные прогревать").
// Each warm-up domain defaults to enabled; a domain the user switched off is
// persisted under mvs_erp_warmup_<name> as '0'. The warm-up loop (warmup.ts)
// reads warmupEnabled[stepName] and skips a step whose value is false.
// ---------------------------------------------------------------------------

const WARMUP_KEY_PREFIX = 'mvs_erp_warmup_'

function readWarmupFlag(name: string): boolean {
  try {
    const raw = localStorage.getItem(WARMUP_KEY_PREFIX + name)
    return raw == null ? true : raw === '1'
  } catch {
    // storage unavailable — default to enabled
    return true
  }
}

/** Explicit (user-overridden) toggles, used as the write-through backing store */
const warmupToggles = reactive<Record<string, boolean>>({})

/**
 * Reactive per-domain warm-up switches. Reading a domain that has no explicit
 * toggle falls back to the persisted value (default enabled). Assigning a value
 * records it so the setting survives reloads.
 */
export const warmupEnabled = new Proxy<Record<string, boolean>>(warmupToggles, {
  get(target, prop) {
    if (typeof prop === 'string' && prop in target) return target[prop]
    if (typeof prop === 'string') return readWarmupFlag(prop)
    return undefined
  },
  set(target, prop, value) {
    if (typeof prop === 'string') target[prop] = value as boolean
    return true
  },
})

/** Effective enabled state for a domain (defaults to enabled). */
export function getWarmupStep(name: string): boolean {
  return warmupEnabled[name]
}

/** Flips a domain's warm-up toggle and persists. */
export function toggleWarmupStep(name: string): void {
  warmupEnabled[name] = !getWarmupStep(name)
  saveWarmupSettings()
}

/** Persists the current warm-up toggles to localStorage. */
export function saveWarmupSettings(): void {
  try {
    for (const [name, enabled] of Object.entries(warmupToggles)) {
      localStorage.setItem(WARMUP_KEY_PREFIX + name, enabled ? '1' : '0')
    }
  } catch {
    // settings are not critical
  }
}
// ---------------------------------------------------------------------------
// View settings (the right pane of the "Settings" screen).
// Client-side, per-device (no persistence across devices), applied the next
// time a planning page is opened. No TTL — cleared only by explicit browser
// storage purge / local-storage reset of the user's choosing.
// ---------------------------------------------------------------------------


export const VIEW_SETTINGS_KEY = 'mvs_erp_view_settings'

export interface ViewSettings {
  /** Gantt badges: resource (specialization) on the task bars */
  badgeResource: boolean
  /** Project-code badges are independent for process and task bars. */
  badgeProcessProjectCode: boolean
  badgeTaskProjectCode: boolean
  /** Gantt badge: "% of completed operations" on task bars */
  badgeProgress: boolean
  /** Gantt badges/labels — per entity: owner (assignee/владелец) and
   *  responsible (ответственный), toggled independently per entity. */
  badgeProjectOwner: boolean
  badgeProjectResponsible: boolean
  badgeProcessOwner: boolean
  badgeProcessResponsible: boolean
  badgeTaskOwner: boolean
  badgeTaskResponsible: boolean
  /** Gantt badge: the comments bubble + counter on task bars (the panel itself
   *  stays reachable from the bar context menu either way) */
  badgeComments: boolean
  /** Timeline unit the diagrams open in: day cells or decade cells */
  defaultUnit: PlanningUnit
  /** Initial table zoom (%) applied when a diagram is first opened in a session */
  defaultScale: number
  /** Initial cell width at open (% of the responsive base column width for the
   *  current window). 50–200%; 100 keeps the adaptive default (no fixed cell). */
  defaultCellZoom: number
  /** How long a project created from the UI lasts, in days (the "Создать" button / right-click) */
  defaultProjectDays: number
  /** Whether the visible "Save to PDF / Print" toolbar buttons are shown */
  showPdfButtons: boolean
  /** How the task dependency links are drawn in the diagrams */
  connector: LinkStyle
}

const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  badgeResource: true,
  badgeProcessProjectCode: true,
  badgeTaskProjectCode: true,
  badgeProgress: true,
  badgeProjectOwner: true,
  badgeProjectResponsible: true,
  badgeProcessOwner: true,
  badgeProcessResponsible: true,
  badgeTaskOwner: true,
  badgeTaskResponsible: true,
  badgeComments: true,
  defaultUnit: 'day',
  defaultScale: 100,
  defaultCellZoom: 100,
  defaultProjectDays: 180,
  showPdfButtons: true,
  connector: LINK_STYLE_DEFAULT,
}

function readViewSettings(): ViewSettings {
  try {
    const raw = localStorage.getItem(VIEW_SETTINGS_KEY)
    if (raw == null) return { ...DEFAULT_VIEW_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ViewSettings> & { badgeProjectCode?: boolean }
    const { badgeProjectCode: legacyProjectCode, ...stored } = parsed
    // The stored blob may predate this key (or hold garbage) — never trust it.
    // A stale "decade" default is coerced to day: the default unit is now
    // only day or week (decade stays an in-session scale, not a default).
    const defaultUnit = parsed.defaultUnit === 'week' ? 'week' : 'day'
    return {
      ...DEFAULT_VIEW_SETTINGS, ...stored, defaultUnit,
      badgeProcessProjectCode: parsed.badgeProcessProjectCode ?? legacyProjectCode ?? true,
      badgeTaskProjectCode: parsed.badgeTaskProjectCode ?? legacyProjectCode ?? true,
      connector: normalizeLinkStyle(parsed.connector),
    }
  } catch {
    return { ...DEFAULT_VIEW_SETTINGS }
  }
}

/** Live view-settings state (mutation = applied on next page open). */
export const viewSettings = reactive<ViewSettings>(readViewSettings())

watch(
  viewSettings,
  () => saveViewSettings(),
  { deep: true },
)

/** Persists the current view settings. */
export function saveViewSettings(): void {
  try {
    localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(viewSettings))
  } catch {
    // not critical
  }
}

/** Default-scale range offered by the UI (%), matching useTimelineZoom bounds (0.5–2). */
export const SCALE_MIN = 50
export const SCALE_MAX = 200
export const SCALE_STEP = 5

/** Default cell-width zoom offered by the UI (%), centered on the responsive base. */
export const CELL_ZOOM_MIN = 50
export const CELL_ZOOM_MAX = 200
export const CELL_ZOOM_STEP = 5

/** Default project duration offered by the UI (days, used on project create). */
export const PROJECT_DAYS_MIN = 1
export const PROJECT_DAYS_MAX = 1095
export const PROJECT_DAYS_STEP = 1

/** Hard upper bound of the physical cell width in px (mirrors ZOOM_MAX in useTimelineZoom). */
export const MAX_CELL_PX = 100

// ---------------------------------------------------------------------------
// Interface preferences (theme is in theme.ts; font scale and table page size
// live here). Per-device, localStorage, applied live.
// ---------------------------------------------------------------------------

/** UI font scale options; applied via `data-ui-size` on <html> -> --ui-font-scale. */
export type UiFontSize = 'small' | 'default' | 'large'

const FONT_SIZE_KEY = 'mvs_erp_ui_font_size'

function readUiFontSize(): UiFontSize {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY)
    if (raw === 'small' || raw === 'default' || raw === 'large') return raw
  } catch {
    // fall through
  }
  return 'default'
}

/** Global interface font scale (small 0.9 / default 1 / large 1.1). */
export const uiFontSize = ref<UiFontSize>(readUiFontSize())

/** Applies the font scale to the document (called on boot and on change). */
export function applyUiSize(): void {
  document.documentElement.dataset.uiSize = uiFontSize.value
}

/** Table page-size options (list pages and the audit log). */
export const TABLE_PAGE_SIZE_OPTIONS = [25, 50, 100] as const
export type TablePageSize = (typeof TABLE_PAGE_SIZE_OPTIONS)[number]

const TABLE_PAGE_SIZE_KEY = 'mvs_erp_table_page_size'

function readTablePageSize(): TablePageSize {
  try {
    const n = Number(localStorage.getItem(TABLE_PAGE_SIZE_KEY))
    return (TABLE_PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? (n as TablePageSize) : 50
  } catch {
    return 50
  }
}

/** Records per page for paged tables (resources, employees, audit log). */
export const tablePageSize = ref<TablePageSize>(readTablePageSize())

/** Persists the interface preferences to localStorage. */
export function saveUiSettings(): void {
  try {
    localStorage.setItem(FONT_SIZE_KEY, uiFontSize.value)
    localStorage.setItem(TABLE_PAGE_SIZE_KEY, String(tablePageSize.value))
  } catch {
    // settings are not critical
  }
}
