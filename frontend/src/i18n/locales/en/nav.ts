import type ru from '../ru/nav'
import type { Translation } from '../types'

export default {
  sections: 'Sections',
  planner: 'Planner',
  projects: 'Projects',
  processes: 'Processes',
  tasks: 'Tasks',
  timesheet: 'Timesheet',
  employees: 'Employees',
  resources: 'Resources',
  admin: 'Admin',
  users: 'Users',
  structure: 'Company structure',
  autoCreate: 'Project template',
  statuses: 'Timesheet day types',
  permissions: 'Roles',
  audit: 'Audit log',
  system: 'System',
  queue: 'Change queue',
  settings: 'Settings',
} satisfies Translation<typeof ru>
