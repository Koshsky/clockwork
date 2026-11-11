import type { TimelineCtx } from '@/composables/timeline-context'

export interface ProcessBarProps {
  /** Infinite timeline context */
  timeline: TimelineCtx
  startDate: string | Date | number
  endDate: string | Date | number
  title: string
  projectCode?: string
  ownerName?: string
  ownerShort?: string
  responsibleName?: string
  responsibleShort?: string
  color?: string
  opacity?: number
  /** Enables dragging and duration-resize handles */
  draggable?: boolean
  /** Vertical row reorder: pressing the bar body and dragging vertically calls
   *  this with the pointerdown event (horizontal drags keep changing dates). */
  startRowReorder?: ((e: PointerEvent) => void) | null
  /** Project bounds — restrict dragging of the process */
  groupStartDate?: string | Date | number | null
  groupEndDate?: string | Date | number | null
  /** Bar height in px (default 24) */
  height?: number
  /** Bar offset from the top of the row in px (default 1) */
  top?: number
}
