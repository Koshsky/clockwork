import { nextTick } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { LABEL_WIDTH } from '../components/planner/layout'
import { clamp } from '../utils'
import { DBLCLICK_IGNORE_SELECTOR } from './timeline-context'
import {
  ensureRange,
  readRootCellWidth,
  windowStartFor,
  type TimelineRange,
} from './timelineHelpers'

/** Upper bound for cell-width zoom (px). The minimum is unbounded —
 *  cells can shrink arbitrarily (technical floor of 1px). */
const ZOOM_MAX = 100
/** Bounds of the table CSS zoom (zoom on .tg-content) */
const SCALE_MIN = 0.5
const SCALE_MAX = 2

export interface TimelineZoomOptions {
  container: Ref<HTMLElement | null>
  contentEl: Ref<HTMLElement | null>
  cellPx: Ref<number>
  leftPad: Ref<number>
  rightCells: Ref<number>
  windowStart: Ref<number>
  tableScale: Ref<number>
  scaleBump: Ref<number>
  viewportCells: ComputedRef<number>
  sync: () => void
}

/**
 * Zoom of the infinite timeline: two independent scales — the table-wide CSS zoom
 * (applyTableScale) and the cell width (zoomTo). Both center on the point under
 * the cursor; the range is extended immediately at the new scale so scrollLeft is
 * not clamped to the old content width. Ctrl+wheel — overall zoom, Ctrl+Shift —
 * cell width, double click — reset.
 */
export function useTimelineZoom(opts: TimelineZoomOptions) {
  const { container, contentEl, cellPx, leftPad, rightCells, windowStart, tableScale, scaleBump, viewportCells, sync } = opts
  const range: TimelineRange = { leftPad, rightCells, cellPx, viewportCells }

  /**
   * Cell-width zoom (horizontal scale only): changes the cell width while keeping
   * the cell under anchorX (local, unscaled coordinate inside the container) in
   * place — the cursor is the zoom center.
   */
  function zoomTo(newPx: number, anchorX: number, persist = true) {
    const el = container.value
    if (!el) return
    const px = clamp(newPx, 1, ZOOM_MAX)
    if (px === cellPx.value) return
    const oldPx = cellPx.value
    const scale = tableScale.value
    const cellFloat =
      (el.scrollLeft / scale + anchorX - LABEL_WIDTH) / oldPx - leftPad.value
    cellPx.value = px
    if (persist) {
      el.style.setProperty('--cell-width', px + 'px')
    } else {
      el.style.removeProperty('--cell-width')
    }
    let nsl = LABEL_WIDTH + (cellFloat + leftPad.value) * px - anchorX
    const vs = windowStartFor(nsl, px, leftPad.value)
    ensureRange(vs, range, (step) => {
      nsl += step * px
    })
    windowStart.value = windowStartFor(nsl, px, leftPad.value)
    void nextTick().then(() => {
      el.scrollLeft = nsl * tableScale.value
      sync()
    })
  }

  /**
   * Scale the whole table (cells, rows, fonts, bars) with a CSS zoom on
   * .tg-content. Zoom anchor: horizontally — the point under the cursor (vpX),
   * vertically — the very top of the container (scrollTop scales, the top edge
   * stays in place). scrollLeft/scrollTop are in scaled px.
   */
  function applyTableScale(newScale: number, vpX: number) {
    const el = container.value
    if (!el) return
    const s = clamp(newScale, SCALE_MIN, SCALE_MAX)
    if (s === tableScale.value) return
    const old = tableScale.value
    scaleBump.value++
    // Local content coordinates under the cursor (in px) before the scale change;
    // vertically the anchor is the container top (y = scrollTop/old), not the cursor.
    const x = (el.scrollLeft + vpX) / old
    const y = el.scrollTop / old
    tableScale.value = s
    if (contentEl.value) contentEl.value.style.zoom = String(s)
    // New scrollLeft/scrollTop in scaled px so the anchor
    // (mouse on X, top on Y) does not move.
    let nsl = x * s - vpX
    const nst = y * s
    // Extend the range for the new scrollLeft before flush, otherwise the browser
    // clamps it to the smaller content width and the anchor is lost.
    const vs = windowStartFor(nsl / s, cellPx.value, leftPad.value)
    ensureRange(vs, range, (step) => {
      nsl += step * cellPx.value * s
    })
    windowStart.value = windowStartFor(nsl / s, cellPx.value, leftPad.value)
    void nextTick().then(() => {
      el.scrollLeft = nsl
      el.scrollTop = nst
      sync()
    })
  }

  /**
   * Reset to the initial scales (scale → 1, cell width → the responsive default
   * from :root --cell-width); the point under the cursor stays fixed.
   */
  function resetAll(vpX: number) {
    const el = container.value
    if (!el) return
    const scale = tableScale.value
    const anchorLocal = clamp(vpX / scale, LABEL_WIDTH, el.clientWidth / scale)
    const oldPx = cellPx.value
    const cellFloat =
      (el.scrollLeft / scale + anchorLocal - LABEL_WIDTH) / oldPx - leftPad.value
    const px = readRootCellWidth()
    cellPx.value = px
    el.style.removeProperty('--cell-width')
    tableScale.value = 1
    scaleBump.value++
    if (contentEl.value) contentEl.value.style.zoom = ''
    let nsl = LABEL_WIDTH + (cellFloat + leftPad.value) * px - anchorLocal
    const vs = windowStartFor(nsl, px, leftPad.value)
    ensureRange(vs, range, (step) => {
      nsl += step * px
    })
    windowStart.value = windowStartFor(nsl, px, leftPad.value)
    void nextTick().then(() => {
      el.scrollLeft = nsl
      sync()
    })
  }

  /**
   * Ctrl+wheel — scale the whole table around the cursor (X anchor — mouse,
   * Y anchor — container top); Ctrl+Shift+wheel — zoom cell width around the
   * cursor; otherwise regular scrolling.
   */
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return
    const el = container.value
    if (!el) return
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const vpX = e.clientX - rect.left
    // Zoom step: exactly ±10% per wheel click (deltaY = 120), at most 10% per event
    const factor = Math.pow(1.1, clamp(e.deltaY / 120, -1, 1))
    if (e.shiftKey) {
      const local = clamp(vpX / tableScale.value, LABEL_WIDTH, rect.width / tableScale.value)
      zoomTo(cellPx.value * factor, local)
      return
    }
    applyTableScale(tableScale.value * factor, vpX)
  }

  /** Double click on empty timeline space — reset both scales */
  function onDblClick(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (target.closest(DBLCLICK_IGNORE_SELECTOR)) {
      return
    }
    const el = container.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    resetAll(e.clientX - rect.left)
  }

  return { zoomTo, applyTableScale, resetAll, onWheel, onDblClick }
}
