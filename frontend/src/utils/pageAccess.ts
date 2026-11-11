import { timesheetPageAccessible } from './timesheetAccess'
import { resourcePageAccessible } from './resourceAccess'

export const PAGE_PERMISSIONS: Record<string, readonly [string, string]> = {
  timesheet: ['worker', 'view'],
  employees: ['worker', 'view'],
  projects: ['project', 'view'],
  processes: ['process', 'view'],
  planner: ['task', 'view'],
  resources: ['resource', 'view'],
  users: ['user_admin', 'view'],
  'user-new': ['user_admin', 'create'],
  'user-edit': ['user_admin', 'update'],
  'user-access': ['rbac_config', 'update'],
  structure: ['org_structure', 'view'],
  'auto-create': ['auto_create', 'update'],
  permissions: ['rbac_config', 'update'],
  audit: ['audit', 'view'],
}

export function pageAllowed(name: string, can: (resource: string, action: string) => boolean): boolean {
  if (name === 'timesheet') return timesheetPageAccessible(can)
  if (name === 'auto-create') return can('auto_create', 'view') || can('auto_create', 'update')
  if (name === 'resources') return resourcePageAccessible(can)
  const needed = PAGE_PERMISSIONS[name]
  return !needed || can(...needed)
}
