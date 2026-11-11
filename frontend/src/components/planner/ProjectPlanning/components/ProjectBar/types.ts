import type { TimelineCtx } from '@/composables/timeline-context'

export interface ProjectBarProps {
  /** Infinite timeline context */
  timeline: TimelineCtx
  startDate: string
  endDate: string
  projectCode: string
  priority?: number
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
}
