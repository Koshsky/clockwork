export interface UsageCellProps {
  /** How much of the resource is used (by assignments) */
  used: number
  /** How much of the resource is available (from /timesheet/calendar); null — cell outside the load window */
  available: number | null
  /** Whether the day is a weekend */
  isWeekend: boolean
}
