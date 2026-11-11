import type { TimelineCtx } from '@/composables/timeline-context'
import type { DtoCommentResponse, DtoUserInfo } from '@/api'
import type { Task } from './components/TaskBar/types'
import type { DependencyEdge } from '../../../dependencies'

/** Process milestone — a single point on the timeline with a title and description */
export interface Milestone {
  id: number
  title: string
  content?: string
  date: string
  /** Marker and ray color (default amber #fbbc04) */
  color?: string
}

export interface TaskGanttProps {
  timeline: TimelineCtx
  title: string
  projectCode?: string
  /** Parent process id (for creating tasks/milestones in the group) */
  processId?: number
  tasks: Task[]
  resourceBadgeIds?: ReadonlySet<number>
  milestones?: Milestone[]
  groupStartDate?: string | Date | number | null
  groupEndDate?: string | Date | number | null
  /** Allows modifying tasks and milestones: moving dates, editing, deleting */
  canManage?: boolean | ((taskId: number) => boolean)
  canManageMilestones?: boolean
  /** Enables vertical row drag to reorder the tasks of the process */
  reorderable?: boolean
  /** Users directory — comment author names in task tooltips */
  users?: DtoUserInfo[] | null
  /** Per-task comment cache (for the log in the tooltip) */
  commentsByTask?: Record<number, DtoCommentResponse[]> | null
  /** Scheduling links between the process's top-level tasks (arrow overlay) */
  dependencies?: DependencyEdge[]
}
