import type { DtoDetailedProject } from '@/api'
import type { PlanningUnit } from '../calendar'
import type { ProcessItem } from './components/ProcessGantt/types'

export interface ProcessPlanningProject {
  id: number
  project_code: string
  /** Own temporal bounds of the project */
  start_date: string
  end_date: string
  owner_id?: number
  priority?: number
  processes: ProcessItem[]
}

export interface ProcessPlanningProps {
  projects?: DtoDetailedProject[] | null
  loading?: boolean
  error?: string | null
  /** Timeline anchor: cell with index 0 (starting position) */
  origin?: string | Date
  /** Cell unit: day or decade */
  unit?: PlanningUnit
}

export type { PlanningUnit }
