/**
 * Localized labels of the dependency connector styles (Settings → Diagrams).
 *
 * This module reads the i18n instance, so it must NOT be pulled into
 * `src/settings.ts`: that module is imported by `@/i18n` itself, and a label
 * catalog there would close the cycle `settings → i18n → settings`. The style
 * values and their default live in the import-free ./linkStyle.
 */
import { t } from '@/i18n'
import { LINK_STYLES, type LinkStyle } from './linkStyle'

/** Catalog keys of the style labels, one per style. */
const LABEL_KEYS: Record<LinkStyle, string> = {
  sharp: 'adminSystem.settings.defaults.connectorSharp',
  rounded: 'adminSystem.settings.defaults.connectorRounded',
  smooth: 'adminSystem.settings.defaults.connectorSmooth',
  's-curve': 'adminSystem.settings.defaults.connectorSCurve',
  hockey: 'adminSystem.settings.defaults.connectorHockey',
  metro: 'adminSystem.settings.defaults.connectorMetro',
}

/** Localized label of one style (call-time — a language switch re-renders). */
export function linkStyleLabel(style: LinkStyle): string {
  return t(LABEL_KEYS[style])
}

/** Settings options of the style picker, in the `LINK_STYLES` order. */
export function linkStyleOptions(): Array<{ value: LinkStyle; label: string }> {
  return LINK_STYLES.map((value) => ({ value, label: linkStyleLabel(value) }))
}
