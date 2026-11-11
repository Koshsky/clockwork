import type { TimelineCtx } from '@/composables/timeline-context'
import type { DtoUserResponse, DtoUserStateResponse, DtoStateResponse } from '@/api'

/** Timesheet employee — a user with the worker role */
export type EmployeeWithTitle = DtoUserResponse

export interface AssignPayload {
  employeeId: number
  stateId: number
  startDate: string
  endDate: string
}

export interface ClearPayload {
  employeeId: number
  startDate: string
  endDate: string
}

export interface TimesheetGridProps {
  t: TimelineCtx
  employees: EmployeeWithTitle[]
  states: DtoStateResponse[]
  /** state_id → user-defined color; overrides the palette fallback in swatches and cells */
  colorMap?: Record<number, string>
  /** State covering an employee's day (undefined — a workday) */
  stateForDay: (employeeId: number, iso: string) => DtoUserStateResponse | undefined
  /** Load/save error */
  error?: string | null
  /** Saving in progress (blocks the assignment panel) */
  busy?: boolean
  /** Whether the user may assign states to an employee's days (worker.update) */
  canAssign?: (employeeId: number) => boolean
  /** Whether the user may clear an employee's day ranges (worker.delete) */
  canClear?: (employeeId: number) => boolean
}
