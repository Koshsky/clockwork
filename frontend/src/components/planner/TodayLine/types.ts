import type { TimelineCtx } from '../../../composables/timeline-context'

export interface TodayLineProps {
  /** Infinite timeline context */
  timeline: TimelineCtx
  /** Ray color (default red) */
  color?: string
  /** Ray width, px */
  width?: number
  /** Ray offset to the right of the "yesterday/today" boundary, px */
  offset?: number
}
