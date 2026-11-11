import type { TimelineCtx } from '../../../composables/timeline-context'

export interface GroupGanttItem {
  id: number
  title: string
  start_date: string
  end_date: string
}

/**
 * Item type exposed to the row/bar slots. The default GroupGanttItem covers
 * the group's own rendering; consumers (TaskGantt/ProjectGantt/ProcessGantt)
 * render richer row objects through these slots, so the slot item is a
 * superset of the fields they read (project priority/name, task resources).
 */
export interface GroupGanttSlotItem extends GroupGanttItem {
  color?: string
  priority?: number
  owner_name?: string
  owner_short?: string
  responsible_name?: string
  responsible_short?: string
  resources: Array<{
    resource_id: number
    assignment_id: number
    quantity: number
    code: string
    title?: string
    color?: string
  }>
}

export interface GroupGanttProps {
  /** Infinite timeline context */
  timeline: TimelineCtx
  items: GroupGanttItem[]
  /** Group bounds (optional — highlight on the timeline) */
  groupStartDate?: string | Date | number | null
  groupEndDate?: string | Date | number | null
  /** Enables row reordering: the bar rows of the group start reorder on a
   *  vertical drag of the bar body (see the #bar slot's startReorder) */
  reorderable?: boolean
  /** Merges the label column into one cell spanning the whole group height (#label slot) */
  mergedLabel?: boolean
  /** Parent group identifier (project_id/process_id) — for creating inside the group */
  groupId?: string | number | null
  /** Row height in px (default 26); sets .gg-row and merged-label height */
  rowHeight?: number
  /** Min merged-label height (px): so code/name/dates don't shrink or vanish with 0–1 rows */
  minLabelHeight?: number
  /** Minimum number of group rows (empty placeholder rows pad up to this count) */
  minRows?: number
}
