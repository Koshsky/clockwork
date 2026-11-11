import type { DtoUserStateResponse } from '@/api'

export interface TimesheetCellProps {
  /** State covering the day; null — a workday without a record */
  state?: DtoUserStateResponse | null
  /** state_id → user-defined color (custom color of the state) */
  colorMap?: Record<number, string>
  /** Whether the day is a day off (when there is no state) */
  isWeekend?: boolean
  /** Cell is selected (drag range selection) */
  selected?: boolean
  /** Whether to show the state code (wide cells) */
  showText?: boolean
  /** Date range of the active selection this cell belongs to (assignment tooltip) */
  selectionRange?: { start: string; end: string } | null
  /** When true, the hover tooltip is suppressed (while a range is being dragged) */
  tooltipDisabled?: boolean
}
