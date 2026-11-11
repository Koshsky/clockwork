import type { PlanningUnit } from '../calendar'
import type { PdfGanttGroup } from './pdfRenderer'

export interface PdfExportTaskResource {
  id?: number
  code?: string
  title?: string
  quantity?: number
}

export interface PdfExportTask {
  id?: number
  title?: string
  start_date?: string
  end_date?: string
  resources?: PdfExportTaskResource[]
}

export interface PdfExportMilestone {
  id?: number
  title?: string
  date?: string
}

/** Resource for the occupancy block (DTO /resources) — without @/api import */
export interface PdfExportResource {
  id?: number
  code?: string
  title?: string
}

/** Availability period (DTO /timesheet/calendar) */
export interface PdfExportResourcePeriod {
  start_date?: string
  end_date?: string
  available?: number
}

/** Resource availability calendar record (DTO /timesheet/calendar) */
export interface PdfExportResourceCalendar {
  resource_id?: number
  periods?: PdfExportResourcePeriod[]
}

/** Structural process type (DTO /planning/tasks) — without @/api import */
export interface PdfExportProcess {
  id?: number
  title?: string
  project_id?: number
  project_code?: string
  start_date?: string
  end_date?: string
  owner_id?: number | null
  tasks?: PdfExportTask[]
  milestones?: PdfExportMilestone[]
}

export interface PdfExportProps {
  captureTarget?: () => HTMLElement | null
  /** Ready print model: groups → rows (built by the planner page) */
  groups?: PdfGanttGroup[] | null
  /** Timeline anchor: cell with index 0 (starting position) */
  origin?: Date | string
  /** Cell unit: day or decade */
  unit?: PlanningUnit
  /** Title in the PDF footer/header */
  pageTitle?: string
  /** Current user id — for the "Only my processes" filter */
  ownerId?: number | null
  /** Current user role — determines filter visibility (vp sees "Only mine") */
  role?: string | null
  /** Diagram scope: determines the print dialog's option and filter set */
  scope?: 'tasks' | 'processes' | 'projects'
  /** Row thickness in screen px (default 26; bar = row − 2px) */
  rowHeight?: number | null
  /** Print period start — the visible timeline window from the page (ISO YYYY-MM-DD) */
  periodFrom?: string | null
  /** Print period end — the visible timeline window from the page (ISO YYYY-MM-DD) */
  periodTo?: string | null
  /** Print scale: page zoom (Ctrl+wheel) — content-density multiplier */
  scale?: number | null
  /** Resources for the occupancy block (ResourceHeader) in print */
  resources?: PdfExportResource[] | null
  /** Resource availability calendar (/timesheet/calendar) — for ResourceHeader */
  calendar?: PdfExportResourceCalendar[] | null
}
