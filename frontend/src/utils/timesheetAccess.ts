export type PermissionCheck = (resource: string, action: string) => boolean

export function dayTypesAccessible(can: PermissionCheck): boolean {
  return can('state', 'view') && ['create', 'update', 'delete'].some((action) => can('state', action))
}

export function timesheetPageAccessible(can: PermissionCheck): boolean {
  return can('worker', 'view') || dayTypesAccessible(can)
}
