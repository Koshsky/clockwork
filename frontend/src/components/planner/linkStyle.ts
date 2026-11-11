/**
 * Dependency connector styles offered to the user (Settings → Diagrams) and
 * used by the Gantt overlay geometry (./dependencyPaths).
 *
 * Deliberately a leaf module with no imports: it is read by the app settings
 * (`src/settings.ts`), which `@/i18n` already imports — pulling the planner
 * geometry (and through it the i18n instance) into that graph would create an
 * import cycle.
 */

/** Connector drawing style of the task dependency links. */
export type LinkStyle = 'sharp' | 'rounded' | 'smooth' | 's-curve' | 'hockey' | 'metro'

/** Every selectable style, in the order the settings UI shows them. */
export const LINK_STYLES: readonly LinkStyle[] = [
  'sharp',
  'rounded',
  'smooth',
  's-curve',
  'hockey',
  'metro',
]

/** Style used when the user has no (or an unknown) saved choice. */
export const LINK_STYLE_DEFAULT: LinkStyle = 'rounded'

/** Falls back to the default style for anything but a known style value. */
export function normalizeLinkStyle(value: unknown): LinkStyle {
  return typeof value === 'string' && (LINK_STYLES as readonly string[]).includes(value)
    ? (value as LinkStyle)
    : LINK_STYLE_DEFAULT
}
