import type { TimelineCtx } from '@/composables/timeline-context'

export interface ProjectGanttItem {
  id: number
  project_code: string
  /** Custom bar color (#RRGGBB); empty — the standard token */
  color?: string
  start_date: string
  end_date: string
  priority?: number
  owner_name?: string
  owner_short?: string
  responsible_name?: string
  responsible_short?: string
}

export interface ProjectGanttProps {
  timeline: TimelineCtx
  projects: ProjectGanttItem[]
  /** Allows reordering rows (changing priorities) */
  reorderable?: boolean
  /** Manage-rights check for a project: editing, deleting, moving dates */
  canManage?: (projectId: number) => boolean
}
