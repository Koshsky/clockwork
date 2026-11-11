import type { DtoProject } from '@/api'
import type { PlanningUnit } from '../calendar'

export interface ProjectItem {
  id: number
  project_code: string
  start_date: string
  end_date: string
}

export interface ProjectPlanningProps {
  projects?: DtoProject[] | null
  /** Timeline anchor: cell with index 0 (starting position) */
  origin?: string | Date
  /** Cell unit: day or decade */
  unit?: PlanningUnit
}

export type { PlanningUnit }
