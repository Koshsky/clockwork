import type { TimelineCtx } from '../../../composables/timeline-context'

export interface MilestoneMarkerProps {
  /** Infinite timeline context */
  timeline: TimelineCtx
  /** Milestone date — a single point on the timeline (flag position) */
  date: string | Date | number
  /** Milestone title — first tooltip row */
  title: string
  /** Milestone description — second tooltip row */
  content?: string
  /** Flag and pole color */
  color?: string
  /** Milestone strip height (px) the flag sits in; below it — a ray down to the group end */
  stripHeight?: number
  /** Allow dragging the milestone (snap by cells; on release — @change) */
  draggable?: boolean
  /** Process bounds — the milestone cannot be dragged beyond them */
  groupStartDate?: string | Date | number | null
  groupEndDate?: string | Date | number | null
}
