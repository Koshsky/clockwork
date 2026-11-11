import type { TimelineCtx } from '@/composables/timeline-context'

export interface ProcessItem {
  id: number
  title: string
  color?: string
  start_date: string
  end_date: string
  owner_id?: number
  owner_name?: string
  owner_short?: string
  responsible_id?: number
  responsible_name?: string
  responsible_short?: string
  project_id?: number
  /** Order of the process within the project (ascending display order) */
  order?: number
}

export interface ProcessGanttProps {
  timeline: TimelineCtx
  projectCode?: string
  /** Parent project id (for creating processes in the group) */
  projectId?: number
  processes: ProcessItem[]
  groupStartDate?: string | Date | number | null
  groupEndDate?: string | Date | number | null
  /** Allows modifying processes: moving dates, editing, deleting */
  canManage?: boolean | ((processId: number) => boolean)
  /** Enables vertical row drag to reorder the processes of the project */
  reorderable?: boolean
}
