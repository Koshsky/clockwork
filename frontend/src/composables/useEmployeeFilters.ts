/**
 * Shared employee filters — a single source of truth for the filter state of
 * the "Employees" and "Timesheet" pages.
 *
 * The state lives at module level (singleton refs), so navigating between the
 * two pages keeps the same filters: changing a filter on one page synchronizes
 * to the other. Filtering is client-side (the roster is already scoped by the
 * backend); the store data (roster, users, resources) is read reactively.
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAppStore, useTimesheetStore } from '../store'
import { compareByName } from '../utils'
import { isWorkerPreset } from '../rbac/presets'
import type { DtoResourceResponse, DtoUserResponse } from '@/api'
import type { DtoUserInfo } from '@/api'

/** Manager filter value: '' — all, 'none' — no manager, number — a manager user id */
export type ManagerFilter = number | 'none' | ''
/** Resource filter value: '' — all, 'none' — no resource, number — a resource id */
export type ResourceFilter = number | 'none' | ''

/** Shared filter state and helpers of the "Employees" / "Timesheet" pages. */
export interface EmployeeFilters {
  search: Ref<string>
  managerFilter: Ref<ManagerFilter>
  resourceFilter: Ref<ResourceFilter>
  managerFilterOptions: ComputedRef<DtoUserInfo[]>
  resourceFilterOptions: ComputedRef<DtoResourceResponse[]>
  applyFilters: (list: DtoUserResponse[]) => DtoUserResponse[]
}

/** Search by full name and position (case-insensitive), shared across pages */
const search = ref('')

/** Filter by manager ('' — all, 'none' — no manager, number — manager id) */
const managerFilter = ref<ManagerFilter>('')

/** Filter by resource ('' — all, 'none' — no resource, number — resource id) */
const resourceFilter = ref<ResourceFilter>('')

/**
 * Snapshot of the full employee roster, taken while no manager filter is
 * active. DtoUserInfo (app.users) carries no manager_id, so "has
 * subordinates" must be computed from the worker list.
 */
const managerPool = ref<DtoUserResponse[]>([])

export function useEmployeeFilters(): EmployeeFilters {
  const ts = useTimesheetStore()
  const app = useAppStore()
  // storeToRefs: the actual refs (setup-store proxy access unwraps refs and
  // would miss whole-value replacement in a watch source).
  const { employees } = storeToRefs(ts)

  /** Sort resources by code/title (resources have no name field) */
  const byResourceLabel = (a: DtoResourceResponse, b: DtoResourceResponse): number =>
    `${a.code ?? ''} ${a.title ?? ''}`.localeCompare(`${b.code ?? ''} ${b.title ?? ''}`, 'ru')

  /** All resources (for the filter select), sorted by code/title */
  const resourcesSorted = computed<DtoResourceResponse[]>(() => [...app.resources].sort(byResourceLabel))

  /**
   * Users that can be a manager (non-worker with at least one direct
   * subordinate in the roster). A DATA filter of the org structure, not an
   * access gate — keep it out of the rbac checks.
   */
  const managerFilterOptions = computed(() =>
    app.users
      .filter(
        (u) =>
          u.id != null &&
          !isWorkerPreset(u.preset) &&
          managerPool.value.some((e) => e.manager_id === u.id),
      )
      .sort(compareByName),
  )

  /**
   * Resource filter options depend on the selected manager filter (admin):
   * a manager → only the resources that contain at least one of his direct
   * subordinates (the roster is already scoped by the backend);
   * 'none' → resources of employees without a manager; '' → all resources.
   */
  const resourceFilterOptions = computed<DtoResourceResponse[]>(() => {
    const m = managerFilter.value
    if (m === '') return resourcesSorted.value
    return app.resources
      .filter((r) =>
        employees.value.some((e) => {
          if (e.id == null || app.resourceByUser[e.id]?.id !== r.id) return false
          return m === 'none' ? e.manager_id == null : e.manager_id === m
        }),
      )
      .sort(byResourceLabel)
  })

  /** Applies search → manager → resource to any employee list. */
  function applyFilters(list: DtoUserResponse[]): DtoUserResponse[] {
    let out = list
    const q = search.value.trim().toLowerCase()
    if (q) {
      out = out.filter((e) => `${e.name ?? ''} ${e.position ?? ''}`.toLowerCase().includes(q))
    }
    // Manager filter ('none' and numeric) is client-side: rendering always reads
    // local data, so the numeric scope is applied here instead of the server.
    if (managerFilter.value === 'none') {
      out = out.filter((e) => e.manager_id == null)
    } else if (typeof managerFilter.value === 'number') {
      out = out.filter((e) => e.manager_id === managerFilter.value)
    }
    if (resourceFilter.value === 'none') {
      out = out.filter((e) => e.id != null && !app.resourceByUser[e.id])
    } else if (typeof resourceFilter.value === 'number') {
      out = out.filter((e) => e.id != null && app.resourceByUser[e.id]?.id === resourceFilter.value)
    }
    return out
  }

  // Keep the roster snapshot current while no manager filter is active
  watch(
    employees,
    (list) => {
      if (managerFilter.value === '') managerPool.value = list
    },
    { immediate: true },
  )

  // Changing the manager filter resets the resource filter, whose options depend
  // on the selected manager (no server reload — filtering is client-side now).
  watch(managerFilter, () => {
    resourceFilter.value = ''
  })

  return {
    search,
    managerFilter,
    resourceFilter,
    managerFilterOptions,
    resourceFilterOptions,
    applyFilters,
  }
}