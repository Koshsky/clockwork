import type { TimelineCtx } from '@/composables/timeline-context'
import type { DtoCommentResponse, DtoUserInfo } from '@/api'

export interface TaskResource {
  resource_id: number
  assignment_id: number
  quantity: number
  code: string
  title?: string
  /** Resource color (#RRGGBB) — colors the resource badge on the bar */
  color?: string
}

export interface Task {
  id: number
  title: string
  /** Custom bar color (#RRGGBB); empty — the standard token */
  color?: string
  start_date: string
  end_date: string
  resources: TaskResource[]
  /** Task owner (assignee): id of the assigned user */
  owner_id?: number | null
  /** Owner name (resolved from owner_id via the users directory) */
  owner_name?: string
  /** Short owner name "Lastname I.O." — for the badge on the task bar */
  owner_short?: string
  /** Task responsible: id of the accountable user */
  responsible_id?: number | null
  /** Responsible name (resolved from responsible_id) */
  responsible_name?: string
  /** Short responsible name "Lastname I.O." — for the badge on the task bar */
  responsible_short?: string
  /** Number of active task comments (from /planning/tasks); 0 — no badge */
  comments_count?: number
  /** Execution status: not_started | in_progress | done (fixed catalog) */
  status?: string
  /** Subtasks (operations) of the task — completion percentage badge */
  subtasks?: Array<{ id: number; title?: string; status?: string }>
}

export interface TaskBarProps {
  timeline: TimelineCtx
  task: Task
  resourceBadgeIds?: ReadonlySet<number>
  /** Project code — displayed as a badge right after the task title */
  projectCode?: string
  /** Custom task color (#RRGGBB); empty — the standard token */
  color?: string
  draggable?: boolean
  /** Process bounds — restrict dragging of the task */
  groupStartDate?: string | Date | number | null
  groupEndDate?: string | Date | number | null
  /** Users directory — comment author names in the tooltip */
  users?: DtoUserInfo[] | null
  /** Per-task comment cache (for the log in the tooltip) */
  commentsByTask?: Record<number, DtoCommentResponse[]> | null
}
