import { t } from '../../../i18n'

export type UsageState = 'normal' | 'warn' | 'critical' | 'unknown' | 'weekend'

export interface UsageStateInput {
  used: number
  available: number | null
  isWeekend?: boolean
}

/**
 * Cell load state by used/available percentage (shared by UsageCell and
 * UsageTooltip): ≤100% normal, up to 160% overload, >160% critical. available === 0
 * with usage — critical; without a period/availability — unknown; a day off — weekend.
 */
export function usageState({ used, available, isWeekend }: UsageStateInput): UsageState {
  if (isWeekend) return 'weekend'
  if (available == null) return 'unknown'
  if (available === 0) return used > 0 ? 'critical' : 'normal'
  const pct = (used / available) * 100
  if (pct <= 100) return 'normal'
  if (pct <= 160) return 'warn'
  return 'critical'
}

/** Load percentage (null if there is nothing to compute from: no data or zero availability) */
export function usagePercent(used: number, available: number | null): number | null {
  if (available == null || available === 0) return null
  return (used / available) * 100
}

/** State color (cell background) — for the usage tooltip marker and label. */
export const USAGE_STATE_COLOR: Record<UsageState, string> = {
  normal: 'var(--ui-usage-ok)',
  warn: 'var(--ui-usage-warn)',
  critical: 'var(--ui-usage-crit)',
  unknown: 'var(--ui-usage-unknown)',
  weekend: 'var(--ui-usage-weekend)',
}

/** Catalog keys of the state labels (resolved at render time, never at import). */
const USAGE_STATE_LABEL_KEY: Record<UsageState, string> = {
  normal: 'ui.usage.normal',
  warn: 'ui.usage.warn',
  critical: 'ui.usage.critical',
  unknown: 'common.noData',
  weekend: 'ui.usage.weekend',
}

/** Human-readable state label in the active language. */
export function usageStateLabel(state: UsageState): string {
  return t(USAGE_STATE_LABEL_KEY[state])
}
