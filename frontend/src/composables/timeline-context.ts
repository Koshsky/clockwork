import type { InjectionKey, Ref } from 'vue'
import type { PlanningUnit } from '../components/planner/calendar'

/**
 * Shared interactive timeline elements: bars, reorder handles, milestones, sticky columns,
 * resource ribbon, corner cell. A right-click on them is not treated as "empty space".
 * Panning (MMB drag) starts from ANY point of the table — content (bars, milestones,
 * sticky labels, headers) must not block moving the table, see useTimelinePan.
 * Note: individual consumer lists add their own specific selectors —
 * `.tg-ms-label` (sticky milestone strip) to pan-ignore, but NOT to contextmenu-ignore
 * (otherwise right-click on the milestone strip stops opening the create menu).
 */
export const INTERACTIVE_SELECTOR =
  '.gantt-bar, .gb-handle, .ms-marker, .row-handle, .gg-label, .gg-merged, ' +
  '.th-corner, .rs-label, .rs-block, .ts-labels, .ts-row'

/**
 * Elements whose double-click does NOT reset the scale (interactive + header).
 * Deliberately excludes the sticky timesheet column/rows (.ts-labels, .ts-row):
 * double-clicking them still resets the zoom, and MMB panning may start from
 * them like from anywhere else.
 */
export const DBLCLICK_IGNORE_SELECTOR =
  '.gantt-bar, .gb-handle, .ms-marker, .row-handle, .gg-label, .gg-merged, ' +
  '.th-corner, .rs-label, .rs-block, .tg-head'

/** provide/inject key: scroll container element of the infinite timeline */
export const TimelineScrollKey: InjectionKey<Ref<HTMLElement | null>> = Symbol('timeline-scroll')
/** provide/inject key: window recompute + range extension (for drag/autoscroll) */
export const TimelineSyncKey: InjectionKey<() => void> = Symbol('timeline-sync')

/**
 * Infinite timeline context for consumers (header, bars, milestones).
 * Values are unwrapped (not refs); dates come via cellStart/cellEnd functions
 * to avoid wrapping Date in a reactive Proxy.
 */
export interface TimelineCtx {
  /** Anchor date YYYY-MM-DD (cell index 0) */
  origin: string
  unit: PlanningUnit
  /** Cell width in px */
  cellPx: number
  /** Container CSS zoom: divide viewport coordinates by scale */
  scale: number
  /** Scale change counter: incremented on every zoom — signal for the scale badge */
  scaleBump: number
  /** Absolute cell index at the left edge of the visible timeline */
  windowStart: number
  /** How many cells fit into the visible area */
  viewportCells: number
  /** Cells to the left of origin (for content-coordinate math) */
  leftPad: number
  /** Total content width in px */
  contentWidth: number
  /** Content coordinate of the visible window grid's left edge */
  gridLeft: number
  /** Indices of visible cells */
  visibleIndices: number[]
  /** Content coordinate of cell i's left edge */
  cellLeft: (i: number) => number
  /** Start date of cell i */
  cellStart: (i: number) => Date
  /** End date of cell i (inclusive) */
  cellEnd: (i: number) => Date
  /** Date under the pointer (YYYY-MM-DD, local) — null over the label column */
  dateAtPointer: (rect: DOMRect | null, clientX: number) => string | null
  /**
   * Fractional absolute cell coordinate under the pointer: `cellLeft(floor(v))` is
   * the left edge of the clicked cell, the fraction is the position inside it.
   * null — the pointer is left of the grid. Goes through the content coordinate, so
   * the fractional scroll of the window and the zoom are accounted for; use it (and
   * not the raw pointer offset + windowStart) for anything that maps a pointer to a
   * cell or a date.
   */
  cellCoordAtPointer: (clientX: number, rect?: DOMRect | null) => number | null
}
