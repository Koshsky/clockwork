import { timesheetPageAccessible } from '@/utils/timesheetAccess'
import { resourcePageAccessible } from '@/utils/resourceAccess'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore, useRbacStore } from '../store'
import { applyCategoryOrder, applyItemOrder } from './useNavigationOrder'

export interface NavItem {
  label: string
  to: string
  name: string
  /** The (resource, action) permission from the backend that unlocks this tab */
  perm?: [string, string]
  /** Role fallback — used only while the permission list is not loaded yet */
  roles?: string[] | null
  /** Compact badge shown on the right of the item ("new", a counter, etc.) */
  badge?: string | number
  /** Bundled Lucide icon name (without the .svg suffix) — rendered from the
   *  asset catalog, overridable by a mounted custom icon of the same name */
  icon?: string
}

export interface NavCategory {
  label: string
  /** Role fallback while permissions are not loaded; null — all authenticated users */
  roles: string[] | null
  items: NavItem[]
}

/**
 * Sidebar menu categories; subcategories open in a popup overlay.
 * Item visibility is driven by the RBAC permissions from /permissions/me
 * (same pairs as the router pagePerm), not by hardcoded roles.
 */
export const NAV_CATEGORIES: NavCategory[] = [
  {
    label: 'nav.planner',
    roles: null,
    items: [
      {
        label: 'nav.projects',
        to: '/projects',
        name: 'projects',
        perm: ['project', 'view'],
        roles: ['dp', 'rp', 'admin'],
        icon: 'chart-gantt',
      },
      {
        label: 'nav.processes',
        to: '/processes',
        name: 'processes',
        perm: ['process', 'view'],
        roles: ['dp', 'rp', 'admin'],
        icon: 'chart-bar-big',
      },
      {
        label: 'nav.tasks',
        to: '/planner',
        name: 'planner',
        perm: ['task', 'view'],
        roles: ['dp', 'rp', 'admin', 'vp'],
        icon: 'chart-bar-stacked',
      },
    ],
  },
  {
    label: 'nav.timesheet',
    roles: ['vp', 'admin'],
    items: [
      { label: 'nav.timesheet', to: '/timesheet', name: 'timesheet', perm: ['worker', 'view'], icon: 'calendar' },
      { label: 'nav.employees', to: '/employees', name: 'employees', perm: ['worker', 'view'], icon: 'user-group' },
      { label: 'nav.resources', to: '/resources', name: 'resources', perm: ['resource', 'view'], icon: 'hammer' },
    ],
  },
  {
    label: 'nav.admin',
    roles: ['admin'],
    items: [
      { label: 'nav.users', to: '/users', name: 'users', perm: ['user_admin', 'view'], icon: 'users-round' },
      { label: 'nav.structure', to: '/structure', name: 'structure', perm: ['org_structure', 'view'], icon: 'network' },
      { label: 'nav.autoCreate', to: '/auto-create', name: 'auto-create', perm: ['auto_create', 'update'], icon: 'wand-sparkles' },
      { label: 'nav.permissions', to: '/permissions', name: 'permissions', perm: ['rbac_config', 'update'], icon: 'file-key' },
      { label: 'nav.audit', to: '/audit', name: 'audit', perm: ['audit', 'view'], icon: 'notebook-text' },
    ],
  },
  {
    label: 'nav.system',
    roles: null,
    items: [
      // «Пульт» (/system/console) and «Статус» (/system/status) stay
      // URL-accessible diagnostics pages but are no longer in the sidebar.
      { label: 'nav.queue', to: '/system/queue', name: 'system-queue', icon: 'list' },
      { label: 'nav.settings', to: '/system/settings', name: 'system-settings', icon: 'settings' },
    ],
  },
]

/** Navigation aware of the current user's RBAC permissions (role — only as a cold-start fallback) */
export function useNavigation() {
  const auth = useAuthStore()
  const rbac = useRbacStore()
  const route = useRoute()

  const role = computed(() => auth.user?.preset ?? '')

  /** Permissions arrived (or were cached) — the permission filter is authoritative */
  const permsReady = computed(() => rbac.permsLoaded || rbac.myPermissions.length > 0)

  /** Permission-filtered categories: items hidden without the right, emptied categories dropped.
   *  After RBAC filtering the categories/items are reordered to the user's saved arrangement. */
  const visibleCategories = computed(() =>
    applyCategoryOrder(
      NAV_CATEGORIES.filter((c) => !c.roles || permsReady.value || c.roles.includes(role.value))
        .map((c) => ({
          ...c,
          items: applyItemOrder(
            c.label,
            c.items.filter((i) => {
              if (permsReady.value) {
                if (i.name === 'timesheet') return timesheetPageAccessible(rbac.can)
                if (i.name === 'auto-create') return rbac.can('auto_create', 'view') || rbac.can('auto_create', 'update')
                if (i.name === 'resources') return resourcePageAccessible(rbac.can)
                return i.perm ? rbac.can(i.perm[0], i.perm[1]) : true
              }
              return !i.roles || i.roles.includes(role.value)
            }),
          ),
        }))
        .filter((c) => c.items.length > 0),
    ),
  )

  /** Category that owns the current route (for highlighting) */
  const activeCategory = computed(() =>
    visibleCategories.value.find((c) => c.items.some((i) => i.name === route.name)),
  )

  return { visibleCategories, activeCategory }
}