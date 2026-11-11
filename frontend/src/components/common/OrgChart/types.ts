import type { DtoAdminUserResponse } from '@/api'
import type { PresetLike } from '../../../utils/presets'

export interface OrgChartProps {
  employees: DtoAdminUserResponse[]
  presets?: PresetLike[]
  stateKey?: string
}
