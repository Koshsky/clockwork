import type { PlanningUnit } from './calendar'

/** Width of the left label column (px) — shared by the planner grid and the overlay layer */
export const LABEL_WIDTH = 180

/** Default/fallback calendar cell width (px). Responsive values are set
 *  via the --cell-width CSS variable on :root (see App.vue); grid tracks use
 *  var(--cell-width, ${CELL_WIDTH}px), so in Storybook (where App.vue is not loaded)
 *  this fallback takes effect. Tracks always have a fixed width and don't depend on content. */
export const CELL_WIDTH = 32

/** Calendar header height (px): day/week — 3 rows, decade — 2 rows. */
export const HEADER_HEIGHT_DAY = 56
export const HEADER_HEIGHT_DECADE = 38
export const HEADER_HEIGHT_WEEK = 56

/** Collapsed header heights (px): month only, month + day numbers */
export const HEADER_HEIGHT_MONTH = 20
export const HEADER_HEIGHT_DAY_NUM = 38

/** Cell width thresholds (px) below which header rows are hidden */
export const CELL_PX_NUM_DAY = 6
export const CELL_PX_WD_DAY = 10
export const CELL_PX_NUM_DECADE = 14
export const CELL_PX_NUM_WEEK = 14
export const CELL_PX_WEEK_DATES = 88

/**
 * Calendar header height for a cell unit. Given a cell width (cellPx),
 * the header collapses progressively: day numbers/weekday names are hidden
 * when the cell is too narrow to read them.
 */
export function headerHeight(unit: PlanningUnit, cellPx?: number): number {
  if (unit === 'day') {
    if (cellPx == null) return HEADER_HEIGHT_DAY
    if (cellPx < CELL_PX_NUM_DAY) return HEADER_HEIGHT_MONTH
    if (cellPx < CELL_PX_WD_DAY) return HEADER_HEIGHT_DAY_NUM
    return HEADER_HEIGHT_DAY
  }
  if (cellPx == null) return unit === 'week' ? HEADER_HEIGHT_WEEK : HEADER_HEIGHT_DECADE
  const threshold = unit === 'week' ? CELL_PX_NUM_WEEK : CELL_PX_NUM_DECADE
  if (cellPx < threshold) return HEADER_HEIGHT_MONTH
  if (unit === 'week' && cellPx < CELL_PX_WEEK_DATES) return HEADER_HEIGHT_DAY_NUM
  return unit === 'week' ? HEADER_HEIGHT_WEEK : HEADER_HEIGHT_DECADE
}
