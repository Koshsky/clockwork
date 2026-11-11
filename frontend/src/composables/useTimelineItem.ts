import { computed, inject } from 'vue'
import { cellRangeForSpan } from '../components/planner/calendar'
import type { CellSpan } from '../components/planner/calendar'
import { useBarDrag } from './useBarDrag'
import {
  TimelineScrollKey,
  TimelineSyncKey,
  type TimelineCtx,
} from './timeline-context'

export interface UseTimelineItemOptions {
  /** Current infinite timeline context (reactive; read on every recompute) */
  timeline: () => TimelineCtx
  /** Parent bounds for clamping the drag */
  groupStartDate?: Date | string | number | null
  groupEndDate?: Date | string | number | null
  /** Item's current cell range (absolute indices) */
  getSpan: () => CellSpan | null
  /** Drag commit: the new cell range */
  onCommit: (span: CellSpan) => void
}

/**
 * Shared scaffolding for a timeline item (bar/milestone): scroll container and sync
 * injection, parent bounds, on-screen visibility (±margin) and glue to useBarDrag.
 */
export function useTimelineItem(options: UseTimelineItemOptions) {
  const scrollEl = inject(TimelineScrollKey, null)
  const timelineSync = inject(TimelineSyncKey, () => {})

  const bounds = computed(() =>
    options.groupStartDate != null && options.groupEndDate != null
      ? cellRangeForSpan(
          options.timeline().origin,
          options.timeline().unit,
          options.groupStartDate,
          options.groupEndDate,
        )
      : null,
  )

  /** The item is hidden if its span does not intersect the visible window (±margin) */
  const visible = computed(() => {
    const span = options.getSpan()
    if (!span) return false
    const t = options.timeline()
    return (
      span.endCell > t.windowStart - 4 && span.startCell < t.windowStart + t.viewportCells + 4
    )
  })

  const { isDragging, cursor, previewStyle, dragSpan, startDrag } = useBarDrag({
    timeline: options.timeline,
    scrollEl: () => scrollEl?.value ?? null,
    sync: timelineSync,
    getSpan: options.getSpan,
    getBounds: () => bounds.value,
    onCommit: options.onCommit,
  })

  return { scrollEl, timelineSync, bounds, visible, isDragging, cursor, previewStyle, dragSpan, startDrag }
}
