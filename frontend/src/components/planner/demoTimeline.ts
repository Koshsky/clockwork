import type { TimelineCtx } from '@/composables/timeline-context'
import {
  cellStartDate,
  cellEndDate,
  fmtDate,
  toDate,
  type PlanningUnit,
} from './calendar'
import { CELL_WIDTH, LABEL_WIDTH } from './layout'

/**
 * Minimal `TimelineCtx` for previews and Storybook demos: fixed parameters, no
 * scroll container (bars are positioned from the left edge). Used by the
 * settings previews (dependency lines, bar badges) and by the component stories,
 * so a preview always measures itself with the planner's own math.
 */
export function makeDemoTimeline(
  origin: string | Date,
  unit: PlanningUnit,
  opts?: { cellPx?: number; windowStart?: number; viewportCells?: number },
): TimelineCtx {
  const o = toDate(origin)
  const cellPx = opts?.cellPx ?? CELL_WIDTH
  const windowStart = opts?.windowStart ?? 0
  const viewportCells = opts?.viewportCells ?? 40
  return {
    origin: fmtDate(o),
    unit,
    cellPx,
    scale: 1,
    scaleBump: 0,
    windowStart,
    viewportCells,
    leftPad: 0,
    contentWidth: LABEL_WIDTH + viewportCells * cellPx,
    gridLeft: LABEL_WIDTH,
    visibleIndices: Array.from({ length: viewportCells }, (_, k) => windowStart + k),
    cellLeft: (i) => (i - windowStart) * cellPx,
    cellStart: (i) => cellStartDate(o, unit, i),
    cellEnd: (i) => cellEndDate(o, unit, i),
    dateAtPointer: () => null,
    // A demo timeline has no scroll container, so pointer mapping is unavailable
    cellCoordAtPointer: () => null,
  }
}
