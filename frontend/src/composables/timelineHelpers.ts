import type { ComputedRef, Ref } from 'vue'
import { CELL_WIDTH, LABEL_WIDTH } from '../components/planner/layout'

/** Range growth step in cells: how much the range grows per single expansion,
 *  so that rebase on left scroll does not happen on every cell */
export function growStep(viewportCells: number): number {
  return Math.max(Math.ceil(viewportCells * 0.5), 12)
}

/** Absolute cell index at the left edge of the timeline from the scroll position */
export function windowStartFor(scrollLeft: number, cellPx: number, leftPad: number): number {
  return Math.floor(scrollLeft / cellPx - leftPad)
}

/**
 * Guard against `Math.floor` landing one cell short on an exact cell boundary:
 * scrollLeft, rect.left and the zoom factor are all fractional, so a coordinate
 * that is mathematically exactly on a boundary can come out a few ulps below it.
 */
const BOUNDARY_EPS = 1e-6

/**
 * Fractional absolute cell coordinate of a point inside the scroll container:
 * `cellLeft(floor(value))` is the left edge of the cell under the point, the
 * fraction is the position inside it. null — the point is left of the timeline area.
 *
 * The conversion has to go through the CONTENT coordinate: the visible window is
 * scrolled by an arbitrary fraction of a cell (`scrollLeft / scale mod cellPx`),
 * so cell boundaries render at `cellLeft(i) * scale - scrollLeft + containerLeft`,
 * not at `LABEL_WIDTH + k * cellPx`. Ignoring the phase makes a click near the
 * left edge of a cell resolve to the previous one — visible as a new bar starting
 * one column earlier than the clicked one.
 *
 * visualX — px from the container's left edge (clientX - rect.left);
 * scrollLeft — the container's scroll in visual px;
 * scale — CSS zoom of the content (applied exactly once, to the scroll offset and
 * to the pointer offset together);
 * cellPx/leftPad — cell width and the range's left padding (cells materialized
 * before the origin).
 */
export function cellCoordAtViewportX(
  visualX: number,
  scrollLeft: number,
  scale: number,
  cellPx: number,
  leftPad: number,
): number | null {
  if (!(cellPx > 0)) return null
  const s = scale > 0 ? scale : 1
  const contentX = (scrollLeft + visualX) / s
  if (contentX < LABEL_WIDTH) return null
  return (contentX - LABEL_WIDTH) / cellPx - leftPad + BOUNDARY_EPS
}

/** Adaptive default cell width from :root --cell-width (falls back to CELL_WIDTH) */
export function readRootCellWidth(): number {
  const rootVar = getComputedStyle(document.documentElement)
    .getPropertyValue('--cell-width')
    .trim()
  const rootPx = rootVar ? parseFloat(rootVar) : CELL_WIDTH
  return Number.isFinite(rootPx) && rootPx > 0 ? rootPx : CELL_WIDTH
}

/** Timeline range refs managed by ensureRange */
export interface TimelineRange {
  leftPad: Ref<number>
  rightCells: Ref<number>
  cellPx: Ref<number>
  viewportCells: ComputedRef<number>
}

/**
 * Extends the range to cover the visible position vs: to the right rightCells grows, to the left —
 * leftPad (shifting the visible area toward the start). adjust(step) is called on left
 * expansion to compensate nsl/scrollLeft by the step (the multiplier varies per
 * call site: px, px*scale, etc.).
 */
export function ensureRange(
  vs: number,
  range: TimelineRange,
  adjust?: (step: number) => void,
): void {
  const step = growStep(range.viewportCells.value)
  const visibleEnd = vs + range.viewportCells.value + 1
  if (visibleEnd + step > range.rightCells.value) {
    range.rightCells.value = visibleEnd + step
  }
  if (vs - step < -range.leftPad.value) {
    range.leftPad.value += step
    adjust?.(step)
  }
}
