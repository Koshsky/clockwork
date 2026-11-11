import { computed, nextTick, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import {
  cellEndDate,
  cellIndexForDate,
  cellStartDate,
  dateAtCellCoord,
  fmtDate,
  windowCells,
  toDate,
  type CalendarCell,
  type PlanningUnit,
} from '../components/planner/calendar'
import { CELL_WIDTH, LABEL_WIDTH } from '../components/planner/layout'
import { viewSettings, MAX_CELL_PX } from '../settings'
import {
  cellCoordAtViewportX,
  ensureRange,
  growStep,
  readRootCellWidth,
  windowStartFor,
  type TimelineRange,
} from './timelineHelpers'
import { useTableState } from './useTableState'
import { useTimelineZoom } from './useTimelineZoom'

export interface InfiniteTimeline {
  /** Cell width in px (from the --cell-width CSS variable, responsive) */
  cellPx: Ref<number>
  /** Table scale (zoom on .tg-content): cells, rows, fonts */
  tableScale: Ref<number>
  /** Scale-change counter: incremented on every zoom — signal for the scale badge */
  scaleBump: Ref<number>
  /** Absolute cell index at the left edge of the visible timeline (floor) */
  windowStart: Ref<number>
  /** How many cells fit in the visible timeline area */
  viewportCells: ComputedRef<number>
  /**
   * Height of the visible timeline area in px (clientHeight, horizontal scrollbar
   * excluded). Unscaled: lengths inside the zoomed content (.tg-content) are
   * multiplied by tableScale, so a consumer that has to cover the visible area
   * divides this by tableScale (see TimelineGrid's --tg-fit-height).
   */
  viewportHeight: Ref<number>
  /** Cells "materialized" to the left of the origin (origin is index 0) */
  leftPad: Ref<number>
  /** Total content width in px: LABEL_WIDTH + (leftPad+rightCells)*cellPx */
  contentWidth: ComputedRef<number>
  /** Visible cells (virtualization): windowStart … windowStart+viewportCells+2 */
  visibleCells: ComputedRef<CalendarCell[]>
  /** content-coordinate of the grid's left edge for the visible window */
  gridLeft: ComputedRef<number>
  /** Indices of visible cells (virtualized rendering) */
  visibleIndices: ComputedRef<number[]>
  /** content-coordinate of the left edge of cell i (absolute index) */
  cellLeft: (i: number) => number
  /** Start date of cell i */
  cellStart: (i: number) => Date
  /** End date of cell i (inclusive) */
  cellEnd: (i: number) => Date
  /** Date under the pointer (for context menu) */
  dateAtPointer: (rect: DOMRect | null, clientX: number) => string | null
  /** Date at a viewport x inside the container (for centering when the unit changes) */
  dateAtViewportX: (viewportX: number, unit?: PlanningUnit) => Date | null
  /** Fractional absolute cell coordinate under the pointer (null — left of the grid) */
  cellCoordAtPointer: (clientX: number, rect?: DOMRect | null) => number | null
  /** Programmatic scroll to a date (the cell with the date lands at the window's left edge) */
  scrollToDate: (date: Date | string | number) => void
  /** Programmatic scroll: the date becomes the window center (day/decade scale change) */
  scrollToCenterDate: (date: Date | string | number) => void
  /** Initialization: starting position = origin at the left edge of the timeline */
  initialize: () => void
  /** Recompute the window and extend the range (called on scroll/resize) */
  sync: () => void
  /** Subscribe to scroll + ResizeObserver */
  mount: () => void
  /** Unsubscribe */
  unmount: () => void
}

/**
 * Infinite horizontal timeline with dynamic expansion.
 * origin is the date anchor (cell index 0). Exactly as many cells as needed for
 * the current position are "materialized" to the left/right; when approaching an
 * edge the range expands (to the right — just width growth, to the left — with
 * scrollLeft compensation, so the picture does not shift). Cell rendering is virtualized (visible window).
 *
 * Scaling (zoomTo/applyTableScale/resetAll) and state persistence are factored
 * out into useTimelineZoom and useTableState.
 */
export function useInfiniteTimeline(
  origin: Date | string,
  unit: Ref<PlanningUnit>,
  container: Ref<HTMLElement | null>,
  contentEl: Ref<HTMLElement | null>,
  /** Stable table id: state (scale + scroll) is preserved between mounts */
  id?: string,
): InfiniteTimeline {
  const cellPx = ref(CELL_WIDTH)
  const leftPad = ref(0)
  const rightCells = ref(0)
  const windowStart = ref(0)
  const viewportWidth = ref(0)
  const viewportHeight = ref(0)
  const tableScale = ref(1)
  /** Incremented on every actual scale change (zoom/reset) */
  const scaleBump = ref(0)

  const viewportCells = computed(() =>
    Math.max(
      Math.ceil((viewportWidth.value / tableScale.value - LABEL_WIDTH) / cellPx.value),
      1,
    ),
  )
  const contentWidth = computed(() =>
    LABEL_WIDTH + (leftPad.value + rightCells.value) * cellPx.value,
  )
  const visibleCells = computed(() => {
    const from = windowStart.value
    const count = viewportCells.value + 2
    return windowCells(toDate(origin), unit.value, from, count)
  })
  /** Indices of visible cells (for virtualized rendering) */
  const visibleIndices = computed(() => {
    const from = windowStart.value
    const count = viewportCells.value + 2
    const arr: number[] = []
    for (let k = 0; k < count; k++) arr.push(from + k)
    return arr
  })
  const gridLeft = computed(
    () => LABEL_WIDTH + (windowStart.value + leftPad.value) * cellPx.value,
  )

  const range: TimelineRange = { leftPad, rightCells, cellPx, viewportCells }

  function cellLeft(i: number): number {
    return LABEL_WIDTH + (i + leftPad.value) * cellPx.value
  }

  /** Start date of cell i (fresh Date — safe for method calls) */
  function cellStart(i: number): Date {
    return cellStartDate(toDate(origin), unit.value, i)
  }

  /** End date of cell i (inclusive) */
  function cellEnd(i: number): Date {
    return cellEndDate(toDate(origin), unit.value, i)
  }

  /**
   * Fractional absolute cell coordinate under the pointer (scroll- and zoom-aware):
   * `cellLeft(floor(value))` is the left edge of the cell under the pointer, the
   * fraction is the position inside it. null — the pointer is left of the timeline
   * area (over the label column).
   *
   * Everything that turns a pointer position into a cell or a date goes through
   * this function (context menu, bar drag): the visible window is scrolled by an
   * arbitrary fraction of a cell, so a formula that only looks at the pointer
   * offset from the container edge and adds `windowStart` silently resolves clicks
   * near the left edge of a cell to the previous one.
   */
  function cellCoordAtPointer(clientX: number, rect?: DOMRect | null): number | null {
    const el = container.value
    if (!el) return null
    const r = rect ?? el.getBoundingClientRect()
    return cellCoordAtViewportX(
      clientX - r.left,
      el.scrollLeft,
      tableScale.value,
      cellPx.value,
      leftPad.value,
    )
  }

  function dateAtPointer(rect: DOMRect | null, clientX: number): string | null {
    const coord = cellCoordAtPointer(clientX, rect)
    return coord == null ? null : fmtDate(dateAtCellCoord(toDate(origin), unit.value, coord))
  }

  /**
   * Date at a viewport x-coordinate inside the container (px as rendered, i.e. from
   * the container's left edge), with the fractional position inside the cell
   * preserved — used to keep the timeline centered on the same date when the unit
   * changes. Accounts for scrollLeft, the zoom and leftPad.
   */
  function dateAtViewportX(viewportX: number, u: PlanningUnit = unit.value): Date | null {
    const el = container.value
    if (!el) return null
    const scale = tableScale.value || 1
    const contentX = (el.scrollLeft + viewportX) / scale
    if (contentX < LABEL_WIDTH) return null
    const cell = Math.floor((contentX - LABEL_WIDTH) / cellPx.value) - leftPad.value
    const s = cellStartDate(toDate(origin), u, cell).getTime()
    const e = cellEndDate(toDate(origin), u, cell).getTime()
    const cellLeftX = LABEL_WIDTH + (cell + leftPad.value) * cellPx.value
    const frac = Math.min(Math.max((contentX - cellLeftX) / cellPx.value, 0), 1)
    return new Date(e > s ? s + frac * (e - s) : s)
  }

  const tableState = useTableState()
  const zoom = useTimelineZoom({
    container,
    contentEl,
    cellPx,
    leftPad,
    rightCells,
    windowStart,
    tableScale,
    scaleBump,
    viewportCells,
    sync,
  })

  /** Update container size and cellPx from the CSS variable */
  function measure() {
    const el = container.value
    if (!el) return
    viewportWidth.value = el.clientWidth
    viewportHeight.value = el.clientHeight
    const raw = getComputedStyle(el).getPropertyValue('--cell-width').trim()
    const px = raw ? parseFloat(raw) : CELL_WIDTH
    if (px > 0 && !Number.isNaN(px)) cellPx.value = px
  }

  function sync() {
    const el = container.value
    if (!el) return
    const scale = tableScale.value
    // scrollLeft is in scaled px: local = visual / scale
    const scrollLeft = el.scrollLeft / scale
    const vs = windowStartFor(scrollLeft, cellPx.value, leftPad.value)
    windowStart.value = vs
    // To the right: extend the range (width grows, scrollbar thins);
    // to the left: extend + compensate scrollLeft so the picture does not shift.
    ensureRange(vs, range, (step) => {
      el.scrollLeft += step * cellPx.value * scale
    })
    windowStart.value = windowStartFor(el.scrollLeft / scale, cellPx.value, leftPad.value)
  }

  /**
   * Programmatic scroll to cell i (optionally `fraction` cells further, 0..1): the
   * cell becomes the left edge of the visible window. The range is extended to
   * cover the target position (including far past — leftPad grows to step − i);
   * applied after the DOM flush.
   */
  function scrollToCell(i: number, fraction = 0) {
    const el = container.value
    if (!el) return
    const step = growStep(viewportCells.value)
    const visibleEnd = i + viewportCells.value + 1
    if (visibleEnd + step > rightCells.value) rightCells.value = visibleEnd + step
    const needLeft = step - i
    if (needLeft > leftPad.value) leftPad.value = needLeft
    const scale = tableScale.value
    void nextTick().then(() => {
      el.scrollLeft = (i + fraction + leftPad.value) * cellPx.value * scale
      sync()
    })
  }

  /** Programmatic scroll to a date: the cell with that date lands at the window's left edge */
  function scrollToDate(date: Date | string | number) {
    scrollToCell(cellIndexForDate(toDate(origin), unit.value, date))
  }

  /**
   * Programmatic scroll: the date becomes the center of the visible window.
   * Used on day/decade scale changes — the timeline shrinks/stretches around
   * the table center, not the left edge.
   */
  /**
   * Programmatic scroll: the date becomes the center of the visible window.
   * Used on day/decade scale changes — the timeline shrinks/stretches around
   * the table center, not the left edge. Same pattern as in zoomTo: the range
   * is extended before scrollLeft is applied (the callback mutates nsl), so
   * the sync() after assignment does not shift anything.
   */
  function scrollToCenterDate(date: Date | string | number) {
    const el = container.value
    if (!el) return
    const scale = tableScale.value
    const targetCell = cellIndexForDate(toDate(origin), unit.value, date)
    // Fractional position of the date inside its cell at the new scale (0..1): for a day — 0
    // (date = cell start), for a decade — the day's position inside the decade.
    const s = cellStartDate(toDate(origin), unit.value, targetCell).getTime()
    const e = cellEndDate(toDate(origin), unit.value, targetCell).getTime()
    const frac = e > s ? (toDate(date).getTime() - s) / (e - s) : 0
    const anchorX = el.clientWidth / scale / 2
    const cellFloat = targetCell + frac
    let nsl = LABEL_WIDTH + (cellFloat + leftPad.value) * cellPx.value - anchorX
    const vs = windowStartFor(nsl, cellPx.value, leftPad.value)
    ensureRange(vs, range, (step) => {
      nsl += step * cellPx.value
    })
    windowStart.value = windowStartFor(nsl, cellPx.value, leftPad.value)
    void nextTick().then(() => {
      el.scrollLeft = nsl * scale
      sync()
    })
  }

  /** Initial scale applied on open when no in-session table state exists yet:
   *  1 = no seeding; >1 = the default view scale seeded for a fresh open. */
  let openedScale = 1

  function initialize() {
    // Restore the saved state (scale) before measure(),
    // so measure() picks up the saved --cell-width from the computed style.
    const stored = tableState.get(id)
    const el0 = container.value
    openedScale = 1
    if (stored && el0) {
      cellPx.value = stored.cellPx
      // Set the inline --cell-width only when it differs from the responsive :root
      // default — otherwise a "reset" scale would freeze and stop reacting to resize.
      if (Math.abs(stored.cellPx - readRootCellWidth()) > 0.5) {
        el0.style.setProperty('--cell-width', stored.cellPx + 'px')
      }
      tableScale.value = stored.scale
      if (contentEl.value) contentEl.value.style.zoom = String(stored.scale)
    } else {
      // No in-session table state (a genuinely fresh open): open at the user's
      // default scale instead of 100%. The scale only seeds the initial view —
      // any later Ctrl+wheel / dblclick zoom behaves normally. Bounded to the
      // same range as useTimelineZoom (0.5–2 = 50–200%).
      const raw = (viewSettings.defaultScale ?? 100) / 100
      const base = raw >= 0.5 && raw <= 2 ? raw : 1
      if (base !== 1 && contentEl.value) {
        openedScale = base
        tableScale.value = base
        contentEl.value.style.zoom = String(base)
      }
      // Cell-width ("Ctrl+Shift+wheel") default: percent (%) of the responsive
      // base column width for the current window. 100% keeps the adaptive default
      // (no inline --cell-width → still reacts to window resize like resetAll);
      // other values freeze the width at the requested size (bound to 1..100 px).
      const wpct = viewSettings.defaultCellZoom ?? 100
      if (wpct !== 100) {
        const basePx = readRootCellWidth()
        const px = Math.min(Math.max(Math.round((basePx * wpct) / 100), 1), MAX_CELL_PX)
        cellPx.value = px
        if (el0 && px !== basePx) el0.style.setProperty('--cell-width', px + 'px')
      }
    }
    measure()
    const step = growStep(viewportCells.value)
    leftPad.value = step
    rightCells.value = viewportCells.value + step * 2
    // The horizontal position is restored in mount(), after the content width has
    // been applied: only the saved DATE is meaningful (see useTableState), and
    // scrollToCell extends the range before setting scrollLeft.
    if (!stored) {
      const el = container.value
      // Fresh open (no state at all): the origin sits at the left edge, scaled by the
      // opening zoom so the initial picture is identical at any default scale.
      if (el) el.scrollLeft = leftPad.value * cellPx.value * openedScale
      windowStart.value = 0
    }
  }

  let observer: ResizeObserver | null = null

  /** view restore has been applied (otherwise unmount overwrites the store with defaults) */
  let stateReady = false

  function onScroll() {
    sync()
  }

  function mount() {
    const el = container.value
    if (!el) return
    initialize()
    const stored = tableState.get(id)
    // Content width updates reactively (leftPad/rightCells) — wait for the DOM to
    // apply, otherwise scrollLeft clamps to the old (zero) width and the position
    // does not reach its cell. scrollToCell extends the range itself (a date far in
    // the past needs a large leftPad), so it runs on its own tick as well.
    void nextTick().then(() => {
      if (stored?.firstDate) {
        // Restore by DATE: a saved scrollLeft in px would mean a different date,
        // because the range grown to the left is re-seeded on every mount.
        scrollToCell(
          cellIndexForDate(toDate(origin), unit.value, stored.firstDate),
          stored.firstFraction,
        )
      } else {
        // Fresh open (or a state without a date): the origin sits at the left edge.
        // Re-applied here, after the content width has been patched into the DOM:
        // before the flush the browser clamps scrollLeft to the old width.
        el.scrollLeft = leftPad.value * cellPx.value * openedScale
        windowStart.value = 0
      }
      // The table may have changed size since the state was saved: a vertical
      // position beyond the current scrollable range would be silently clamped
      // by the browser to the bottom, pinning the last rows into view with no
      // user scroll. A stale position is meaningless — open at the top.
      const savedTop = tableState.getScrollTop(id)
      const maxScroll = el.scrollHeight - el.clientHeight
      el.scrollTop = savedTop <= maxScroll ? savedTop : 0
      sync()
      stateReady = true
    })
    observer = new ResizeObserver(() => {
      measure()
      sync()
    })
    observer.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', zoom.onWheel, { passive: false })
    el.addEventListener('dblclick', zoom.onDblClick)
  }

  function unmount() {
    observer?.disconnect()
    observer = null
    const el = container.value
    // If the restore has not applied yet (fast remount due to a loading flip),
    // the store state is still valid — do not overwrite it.
    if (id && el && stateReady) {
      // The first VISIBLE cell: the label column lives inside the zoomed content, so
      // the timeline area starts at LABEL_WIDTH * scale rendered px, not at 0. The
      // coordinate goes through the same primitive as the pointer mapping — it
      // carries the boundary guard, without which a position exactly on a cell edge
      // is saved one cell short and the view walks left on every tab switch.
      const scale = tableScale.value || 1
      const coord = cellCoordAtViewportX(
        LABEL_WIDTH * scale,
        el.scrollLeft,
        scale,
        cellPx.value,
        leftPad.value,
      )
      const cell = coord == null ? null : Math.floor(coord)
      tableState.save(id, {
        firstDate: cell == null
          ? null
          : fmtDate(cellStartDate(toDate(origin), unit.value, cell)),
        firstFraction: cell == null || coord == null ? 0 : coord - cell,
        cellPx: cellPx.value,
        scale: tableScale.value,
      })
      tableState.saveScrollTop(id, el.scrollTop)
    }
    stateReady = false
    el?.removeEventListener('scroll', onScroll)
    el?.removeEventListener('wheel', zoom.onWheel)
    el?.removeEventListener('dblclick', zoom.onDblClick)
  }

  return {
    cellPx,
    tableScale,
    scaleBump,
    windowStart,
    viewportCells,
    viewportHeight,
    leftPad,
    contentWidth,
    visibleCells,
    visibleIndices,
    gridLeft,
    cellLeft,
    cellStart,
    cellEnd,
    dateAtPointer,
    dateAtViewportX,
    cellCoordAtPointer,
    scrollToDate,
    scrollToCenterDate,
    initialize,
    sync,
    mount,
    unmount,
  }
}
