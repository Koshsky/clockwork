/**
 * Aggregated localization backlog: one list per rollout area, so parallel
 * workstreams touch disjoint files (see hardcodedText.test.ts).
 */
import { PENDING as ui } from './ui'
import { PENDING as adminUsers } from './adminUsers'
import { PENDING as adminConfig } from './adminConfig'
import { PENDING as adminSystem } from './adminSystem'
import { PENDING as planner } from './planner'
import { PENDING as plannerViews } from './plannerViews'
import { PENDING as timesheet } from './timesheet'
import { PENDING as pdf } from './pdf'
import { PENDING as errors } from './errors'
import { PENDING as offline } from './offline'

export const PENDING: string[] = [
  ...ui,
  ...adminUsers,
  ...adminConfig,
  ...adminSystem,
  ...planner,
  ...plannerViews,
  ...timesheet,
  ...pdf,
  ...errors,
  ...offline,
]
