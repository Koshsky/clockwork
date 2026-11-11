/** A single comment log entry in a task tooltip */
export interface BarTooltipComment {
  /** Author name (resolved on the frontend from author_id) */
  author?: string
  /** Short date-time */
  date?: string
  text: string
}

/** Generic diagram entity tooltip: title + rows + resources (task/project/process/milestone) */
export interface BarTooltipProps {
  title: string
  /** Additional rows (dates, owner, priority, content, etc.) */
  rows?: string[]
  /** Resource list with quantities — as a separate block with a divider */
  resources?: { label: string; quantity?: number; color?: string }[]
  /** Task comment log (shows up to 4 entries + "…and N more") */
  comments?: BarTooltipComment[]
  /** Accent color of the header (task=green, project/process=blue, milestone=amber) */
  accent?: string
}

/** Resource usage tooltip: fraction, percent and colored state */
export interface UsageTooltipProps {
  used: number
  available: number | null
  /** Absent resource members (for the "Absent:" section) */
  absentees?: { user_name?: string; state_name?: string; start_date?: string; end_date?: string }[]
}

/** Simple hint/state: title + rows + optional colored marker */
export interface InfoTooltipProps {
  title?: string
  lines?: string[]
  /** Colored marker on the left (e.g. timesheet state color); null/'' — no marker */
  marker?: string | null
}
