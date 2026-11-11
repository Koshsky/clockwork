import { onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'
import type { CellSpan } from '../components/planner/calendar'
import type { TimelineCtx } from './timeline-context'
import { clamp, useWindowPointerTrack } from '../utils'

export type BarDragMode = 'move' | 'resizeStart' | 'resizeEnd'

export interface UseBarDragOptions {
  /** Current infinite-timeline context (reactive, read on every move) */
  timeline: () => TimelineCtx
  /** Timeline scroll container (for rect → cell mapping and autoscroll) */
  scrollEl: () => HTMLElement | null
  /** Recompute the window + extend the range after programmatic scroll */
  sync: () => void
  /** Current bar cell span (absolute indices) */
  getSpan: () => CellSpan | null
  /** Allowed cell span — parent bounds (absolute). null = unbounded */
  getBounds?: () => CellSpan | null
  /** Called on release if the span changed */
  onCommit: (span: CellSpan) => void
}

export interface BarDrag {
  isDragging: Ref<boolean>
  cursor: Ref<'grabbing' | 'ew-resize' | null>
  previewStyle: Ref<Record<string, string | number> | null>
  /** Current cell span while dragging (null — not dragging). Published for live load preview */
  dragSpan: Ref<CellSpan | null>
  startDrag: (e: PointerEvent, mode: BarDragMode) => void
}

const EDGE_MARGIN = 48
const SCROLL_SPEED = 28

/**
 * Bar drag in the infinite timeline: pointer movement is translated to absolute
 * cells through the cell under the cursor (accounts for autoscroll), and the span
 * is clamped to the parent bounds. Near the container edge autoscroll kicks in
 * (rAF loop), which moves the scroll and extends the timeline range.
 */
export function useBarDrag(options: UseBarDragOptions): BarDrag {
  const isDragging = ref(false)
  const cursor = ref<'grabbing' | 'ew-resize' | null>(null)
  const previewStyle = ref<Record<string, string | number> | null>(null)
  const dragSpan = ref<CellSpan | null>(null)

  let mode: BarDragMode | null = null
  let startPointerCell = 0
  let startSpan: CellSpan | null = null
  let lastClientX = 0
  let rafId: number | null = null
  let scrollDir = 0

  /**
   * Fractional cell under the pointer. Goes through the timeline context so the
   * fractional scroll of the window and the zoom are accounted for — the delta
   * below is computed from two such samples, and a formula that ignores the scroll
   * phase shifts both ends inconsistently.
   */
  function currentPointerCell(clientX: number): number {
    const t = options.timeline()
    const el = options.scrollEl()
    if (!el) return startPointerCell
    return t.cellCoordAtPointer(clientX, el.getBoundingClientRect()) ?? startPointerCell
  }

  function computeSpan(clientX: number) {
    const t = options.timeline()
    if (!mode || !startSpan) return
    const delta = currentPointerCell(clientX) - startPointerCell

    const bounds = options.getBounds?.() ?? null
    let bMin = -Infinity
    let bMax = Infinity
    if (bounds) {
      bMin = bounds.startCell
      bMax = Math.max(bounds.endCell, bMin + 1)
    }

    let s = startSpan.startCell
    let end = startSpan.endCell
    if (mode === 'move') {
      // Both edges follow the mouse delta; bounds are clamped by the shared clamp below.
      // At the parent boundary the leading edge "freezes" while the opposite side
      // shrinks (the bar looks like it goes past the boundary but does not);
      // on reverse movement the length grows back to its original value.
      s = Math.round(startSpan.startCell + delta)
      end = Math.round(startSpan.endCell + delta)
    } else if (mode === 'resizeStart') {
      s = clamp(Math.round(startSpan.startCell + delta), bMin, Math.max(bMin, end - 1))
    } else {
      end = clamp(Math.round(startSpan.endCell + delta), Math.min(bMax, s + 1), bMax)
    }

    s = clamp(s, bMin, Math.max(bMin, bMax - 1))
    end = clamp(end, Math.min(bMax, s + 1), bMax)
    dragSpan.value = { startCell: s, endCell: end }
    previewStyle.value = {
      left: t.cellLeft(s) + 'px',
      width: (end - s) * t.cellPx + 'px',
    }
  }

  function autoscrollFrame() {
    const el = options.scrollEl()
    if (!el || scrollDir === 0) return
    el.scrollLeft += scrollDir * SCROLL_SPEED
    options.sync()
    computeSpan(lastClientX)
    rafId = requestAnimationFrame(autoscrollFrame)
  }

  function updateAutoscroll(clientX: number) {
    const el = options.scrollEl()
    if (!el) return
    const rect = el.getBoundingClientRect()
    const dir = clientX < rect.left + EDGE_MARGIN ? -1 : clientX > rect.right - EDGE_MARGIN ? 1 : 0
    if (dir === scrollDir) return
    scrollDir = dir
    if (rafId != null) cancelAnimationFrame(rafId)
    rafId = dir === 0 ? null : requestAnimationFrame(autoscrollFrame)
  }

  function stopAutoscroll() {
    scrollDir = 0
    if (rafId != null) cancelAnimationFrame(rafId)
    rafId = null
  }

  function onMove(e: PointerEvent) {
    lastClientX = e.clientX
    computeSpan(e.clientX)
    updateAutoscroll(e.clientX)
  }

  function onUp() {
    const span = dragSpan.value
    const changed =
      span != null &&
      startSpan != null &&
      (span.startCell !== startSpan.startCell || span.endCell !== startSpan.endCell)
    endDrag()
    if (changed && span) options.onCommit({ ...span })
  }

  const track = useWindowPointerTrack({
    onMove,
    onUp,
    onCancel: endDrag,
  })

  function endDrag() {
    stopAutoscroll()
    mode = null
    startSpan = null
    dragSpan.value = null
    isDragging.value = false
    cursor.value = null
    previewStyle.value = null
    track.stop()
  }

  function startDrag(e: PointerEvent, m: BarDragMode) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return
    const span = options.getSpan()
    if (!span) return
    e.preventDefault()
    mode = m
    lastClientX = e.clientX
    startPointerCell = currentPointerCell(e.clientX)
    startSpan = { ...span }
    dragSpan.value = { ...span }
    isDragging.value = true
    cursor.value = m === 'move' ? 'grabbing' : 'ew-resize'
    previewStyle.value = null
    track.start()
  }

  // The component may unmount mid-drag (data/page change): without this,
  // listeners and userSelect="none" would remain forever.
  onBeforeUnmount(endDrag)

  return { isDragging, cursor, previewStyle, dragSpan, startDrag }
}
