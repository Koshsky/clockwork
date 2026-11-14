export const OWN_DEFAULT_RESOURCES = ['resource', 'project', 'process', 'task', 'milestone', 'assignment'] as const
export function resourcePageAccessible(can: (resource: string, action: string) => boolean): boolean {
  return ['view', 'create', 'update', 'delete'].some((action) => can('resource', action))
}

export { resourceHeaderRows, resourceHeaderOwners, resourceBadgeRows } from '@/domain/resourceAccess'
