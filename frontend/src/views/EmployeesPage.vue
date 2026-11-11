<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ContextMenu, ModalForm, PendingMark, DataTable } from '../components/common'
import type { DataTableColumn } from '../components/common'
import type { ContextMenuItem } from '../components/common/ContextMenu'
import type { ModalField } from '../components/common/ModalForm'
import { useContextMenu } from '../composables/useContextMenu'
import { useEditModal } from '../composables/useEditModal'
import { useRoleAccess } from '../composables/useRoleAccess'
import { useEmployeeFilters } from '../composables/useEmployeeFilters'
import { useAppStore, useTimesheetStore, useRbacStore } from '../store'
import { isOffline } from '../offline/state'
import { scheduleNamedRefresh } from '../offline/sync'
import { useColumnWidths } from '../composables/useColumnWidths'
import { compareByName } from '../utils'
import { fmtDate as fmtDateValue } from '../i18n/date'
import { t } from '../i18n'
import type { DtoResourceResponse, DtoUserResponse } from '@/api'

const ts = useTimesheetStore()
const { employees, employeesWithTitles, loading, error } = storeToRefs(ts)

const app = useAppStore()
const { users } = storeToRefs(app)
const { resources, resourcesError } = storeToRefs(app)

// Edit/delete are NOT available here: an employee IS a system user, so profile
// editing happens only on the admin "Users" page (user-edit right).
// This page only changes the employee's resource.
const { role, userId, canManageResource } = useRoleAccess()

const rbac = useRbacStore()
/** Permissions arrived (or were cached) — the matrix is authoritative; the preset is the cold-start fallback. */
const permsReady = computed(() => rbac.permsLoaded || rbac.myPermissions.length > 0)
/** The manager column/filter makes sense only on the full roster — worker.view with scope all. */
const seesAllEmployees = computed(() =>
  permsReady.value ? rbac.perm('worker', 'view') === 'all' : role.value === 'admin',
)

/**
 * Employee resource (membership is unique: UNIQUE(user_id)) — for the badge,
 * filter, and resource change when editing.
 */
function resourceOf(employeeId: number | undefined): DtoResourceResponse | null {
  if (employeeId == null) return null
  return app.resourceByUser[employeeId] ?? null
}

/**
 * The DataTable cell slot gives the row as `unknown` (generic inference does
 * not reach through the store's refs) — cast to the page's row type here.
 */
const asEmp = (row: unknown): DtoUserResponse => row as DtoUserResponse

/**
 * Column config for the DataTable. Non-admins (see only own employees) do not
 * get the "Manager" column at all — the grid tracks follow the columns.
 */
const columns = computed<DataTableColumn[]>(() => {
  const cols: DataTableColumn[] = [
    { key: 'name', label: t('adminUsers.employees.column.name'), width: 'fit-content(380px)' },
    { key: 'position', label: t('adminUsers.employees.column.position'), width: 'fit-content(280px)' },
    { key: 'resource', label: t('adminUsers.employees.column.resource'), width: 'fit-content(200px)' },
    { key: 'resource_owner', label: t('adminUsers.employees.column.resourceOwner'), width: 'fit-content(260px)' },
    { key: 'hire_date', label: t('adminUsers.employees.column.hireDate'), width: '110px' },
    { key: 'termination_date', label: t('adminUsers.employees.column.terminationDate'), width: '140px' },
  ]
  if (seesAllEmployees.value) {
    cols.push({ key: 'manager_id', label: t('adminUsers.employees.column.manager'), width: 'fit-content(300px)' })
  }
  return cols
})

/** Per-user persisted column widths (drag-resize on the header edges). */
const { columnWidths } = useColumnWidths('employees')

/** Sort resources by code/title (resources have no name field) */
const byResourceLabel = (a: DtoResourceResponse, b: DtoResourceResponse): number =>
  `${a.code ?? ''} ${a.title ?? ''}`.localeCompare(`${b.code ?? ''} ${b.title ?? ''}`, 'ru')

/** Resources the user can manage (admin — all, others — their own) */
const manageableResources = computed<DtoResourceResponse[]>(() =>
  resources.value
    .filter((r) =>
      permsReady.value ? canManageResource(r.owner_id) : role.value === 'admin' || r.owner_id === userId.value,
    )
    .sort(byResourceLabel),
)

/**
 * Badge style of the employee's resource: the custom resource color (soft
 * tinted background) or null — the default accent tokens from CSS.
 */
function resourceBadgeStyle(res: DtoResourceResponse | null): Record<string, string> | null {
  if (!res?.color) return null
  return {
    background: `color-mix(in srgb, ${res.color} 15%, transparent)`,
    color: res.color,
    borderColor: `color-mix(in srgb, ${res.color} 30%, transparent)`,
  }
}

/** Date as DD.MM.YYYY (locale-aware) or «—» */
function fmtDate(iso?: string): string {
  if (!iso) return '—'
  return fmtDateValue(iso)
}

/** Label of the employee's manager */
function managerLabel(managerId?: number | null): string {
  if (managerId == null) return '—'
  if (managerId === userId.value) return t('adminUsers.employees.me')
  const u = users.value.find((x) => x.id === managerId)
  return u?.name ?? `#${managerId}`
}

/** Label of the resource owner (a name from the user catalog) */
function ownerLabel(ownerId?: number | null): string {
  if (ownerId == null) return '—'
  if (ownerId === userId.value) return t('adminUsers.employees.me')
  const u = users.value.find((x) => x.id === ownerId)
  return u?.name ?? `#${ownerId}`
}

/**
 * Sort values for derived columns: `resource` / `resource_owner` are not raw
 * row fields (they come from resourceOf), everything else falls back to the
 * row field itself.
 */
function empSortValue(emp: DtoUserResponse, key: string): string {
  if (key === 'resource') return resourceOf(emp.id)?.code ?? ''
  if (key === 'resource_owner') return ownerLabel(resourceOf(emp.id)?.owner_id)
  return String((emp as unknown as Record<string, unknown>)[key] ?? '')
}

/**
 * Shared employee filters (search / manager / resource) — synchronized with the
 * "Timesheet" page: the state is a single module-level source of truth.
 */
const {
  managerFilter,
  resourceFilter,
  managerFilterOptions,
  resourceFilterOptions,
  applyFilters,
} = useEmployeeFilters()

// Per-column filters local to this page (the shared `search` remains the
// timesheet page's combined name+position filter).
const fName = ref('')
const fPosition = ref('')

/** Owner filter value: '' — all, 'none' — resource without an owner, number — owner user id */
const ownerFilter = ref<number | 'none' | ''>('')

/** Owner options for the filter (non-worker users), like the owner select on Resources */
const ownerFilterOptions = computed(() =>
  [...users.value].filter((u) => u.preset !== 'worker').sort(compareByName),
)

const filteredEmployees = computed(() => {
  const list = applyFilters(employeesWithTitles.value)
  const qName = fName.value.trim().toLowerCase()
  const qPos = fPosition.value.trim().toLowerCase()
  const owner = ownerFilter.value
  return list.filter((emp) => {
    if (qName && !(emp.name ?? '').toLowerCase().includes(qName)) return false
    if (qPos && !(emp.position ?? '').toLowerCase().includes(qPos)) return false
    if (owner !== '') {
      const res = resourceOf(emp.id)
      if (owner === 'none') {
        if (res?.owner_id != null) return false
      } else if (res?.owner_id !== owner) {
        return false
      }
    }
    return true
  })
})

// Right-click on a row: only the resource change. The employee's profile is a
// system user — editing it happens solely on the admin "Users" page.
interface MenuState {
  x: number
  y: number
  employeeId: number
}
const menu = ref<MenuState | null>(null)
const menuItems = computed<ContextMenuItem[]>(() => [
  { id: 'change-resource', label: t('adminUsers.employees.action.changeResource') },
])

type ModalMode = {
  type: 'resource'
  id: number
  resourceId?: number | null
}

/** The resource dialog: one select (manageable resources) + "No resource" */
const { open: openModal, close: closeModal, submit: submitModal, bind: modalBind } = useEditModal<ModalMode>(
  (state) => {
    const fields: ModalField[] = []
    // Only those who can manage a resource (admin — all, others — their own)
    // may change the employee's resource; the backend gates it the same way.
    if (manageableResources.value.length) {
      fields.push({
        key: 'resourceId',
        label: t('adminUsers.employees.action.resourceLabel'),
        type: 'select',
        options: [
          { value: '', label: t('adminUsers.employees.filter.noResource') },
          ...manageableResources.value.map((r) => ({
            value: r.id as number,
            label: `${r.code} — ${r.title}`,
          })),
        ],
        value: state.resourceId != null ? state.resourceId : '',
      })
    }
    return fields
  },
  async (state, values) => {
    const toResourceId = values.resourceId === '' || values.resourceId == null ? null : Number(values.resourceId)
    const ok = await app.changeEmployeeResource(state.id, state.resourceId ?? null, toResourceId)
    if (!ok) {
      return { ok: false, error: app.resourcesError ?? t('adminUsers.employees.error.changeResource') }
    }
    return { ok: true, error: null }
  },
  () => t('adminUsers.employees.action.changeResource'),
  () => t('common.save'),
)

function onRowContextMenu(e: MouseEvent, emp: DtoUserResponse) {
  if (emp.id == null || !manageableResources.value.length) return
  openMenu({ x: e.clientX, y: e.clientY, employeeId: emp.id })
}

const { open: openMenu, close: closeMenu, select, bind: menuBind } = useContextMenu(menu, menuItems, handleSelect)

function openChangeResource(id: number) {
  const emp = employees.value.find((e) => e.id === id)
  if (emp) {
    openModal({
      type: 'resource',
      id,
      resourceId: resourceOf(emp.id)?.id ?? null,
    })
  }
}

function handleSelect(id: string) {
  if (!menu.value) return
  if (id === 'change-resource') {
    openChangeResource(menu.value.employeeId)
  }
}

onMounted(async () => {
  if (!employees.value.length) await ts.loadEmployees()
  if (seesAllEmployees.value && !users.value.length) await app.loadUsers()
  // Load resources and their members unconditionally: resources are often already in the store
  // (dashboard/planner load them earlier), but members — only here;
  // a gate on resources.length would leave everyone "without a resource" without badges.
  // Local-first: hydrate from the cache (no network from the render path).
  await app.ensureResourceMembers(false)
  // Page-entry SWR (online): cache-first render, then re-read the roster and
  // name catalogs so recent user mutations show up immediately.
  if (!isOffline.value) void scheduleNamedRefresh(['employees', 'users', 'myStaff'])
})

/** "Load more": appends the next page of the server-scoped roster */
function onLoadMore() {
  void ts.loadMoreEmployees()
}
</script>

<template>
  <section class="ep">
    <p v-if="loading && !employees.length" class="ep-st">{{ t('common.loading') }}</p>
    <p v-if="error && !employees.length" class="ep-st er">{{ error }}</p>
    <p v-if="resourcesError" class="ep-st er">{{ resourcesError }}</p>

    <!--
      The table frame (header included) stays visible even when the filters
      leave no rows: the empty-state message is rendered inside the table
      instead of replacing it, so the header and filter controls remain usable.
    -->
    <DataTable
      v-if="employees.length || (!loading && !error)"
      :columns="columns"
      :rows="filteredEmployees"
      :title="t('adminUsers.employees.title')"
      :empty-text="employees.length ? t('adminUsers.employees.emptyFound') : t('adminUsers.employees.empty')"
      :sort-value="empSortValue"
      resizable
      v-model:column-widths="columnWidths"
      @row-contextmenu="(e, row) => onRowContextMenu(e, asEmp(row))"
    >
      <!-- Filters live under their columns (maybe none in the toolbar) -->
      <template #filter="{ column }">
        <input
          v-if="column.key === 'name'"
          v-model="fName"
          type="search"
          :placeholder="t('adminUsers.employees.filter.namePlaceholder')"
        />
        <input
          v-else-if="column.key === 'position'"
          v-model="fPosition"
          type="search"
          :placeholder="t('adminUsers.employees.filter.positionPlaceholder')"
        />
        <select
          v-else-if="column.key === 'resource'"
          v-model="resourceFilter"
          class="ep-filter"
          :title="t('adminUsers.employees.filter.resourceTitle')"
        >
          <option value="">{{ t('adminUsers.employees.filter.allResources') }}</option>
          <option value="none">{{ t('adminUsers.employees.filter.noResource') }}</option>
          <option v-for="r in resourceFilterOptions" :key="r.id" :value="r.id">{{ r.code }} — {{ r.title }}</option>
        </select>
        <select
          v-else-if="column.key === 'resource_owner'"
          v-model="ownerFilter"
        >
          <option value="">{{ t('adminUsers.employees.filter.allOwners') }}</option>
          <option value="none">{{ t('adminUsers.employees.filter.noOwner') }}</option>
          <option v-for="u in ownerFilterOptions" :key="u.id" :value="u.id">{{ u.name ?? `#${u.id}` }}</option>
        </select>
        <select
          v-else-if="column.key === 'manager_id' && seesAllEmployees"
          v-model="managerFilter"
          class="ep-filter"
        >
          <option value="">{{ t('adminUsers.employees.filter.allManagers') }}</option>
          <option value="none">{{ t('adminUsers.employees.filter.noManager') }}</option>
          <option v-for="u in managerFilterOptions" :key="u.id" :value="u.id">{{ u.name ?? `#${u.id}` }}</option>
        </select>
      </template>
      <template #cell="{ row, column }">
        <span v-if="column.key === 'name'" class="name">
          {{ asEmp(row).name }}
          <PendingMark entity="user" :id="asEmp(row).id" />
        </span>
        <span v-else-if="column.key === 'position'" class="pos-text">{{ asEmp(row).position || '—' }}</span>
        <span v-else-if="column.key === 'resource'">
          <span
            v-if="resourceOf(asEmp(row).id)"
            class="ep-badge"
            :style="resourceBadgeStyle(resourceOf(asEmp(row).id)) ?? undefined"
            :title="resourceOf(asEmp(row).id)?.title"
          >
            {{ resourceOf(asEmp(row).id)?.code }}
          </span>
          <span v-else class="ep-none">—</span>
        </span>
        <template v-else-if="column.key === 'resource_owner'">{{ ownerLabel(resourceOf(asEmp(row).id)?.owner_id) }}</template>
        <template v-else-if="column.key === 'hire_date'">{{ fmtDate(asEmp(row).hire_date) }}</template>
        <template v-else-if="column.key === 'termination_date'">{{ fmtDate(asEmp(row).termination_date) }}</template>
        <template v-else>{{ managerLabel(asEmp(row).manager_id) }}</template>
      </template>
    </DataTable>

    <!-- Roster pagination: the backend returns PAGE_SIZE (50) rows plus a total;
         the rest is appended on demand (dedup by id). -->
    <div v-if="ts.employeesHasMore" class="ep-more">
      <button type="button" class="ep-more-btn" :disabled="ts.employeesLoadingMore" @click="onLoadMore">
        {{ ts.employeesLoadingMore ? t('common.loading') : t('adminUsers.employees.action.loadMore', { shown: employees.length, total: ts.employeesTotal }) }}
      </button>
    </div>

    <ContextMenu v-bind="menuBind" @select="select" @close="closeMenu" />

    <ModalForm v-bind="modalBind" @save="submitModal" @close="closeModal" />
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

/* Loading / error placeholders outside the table */
.ep-st {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.er { color: var(--ui-danger); }

/* "Load more" footer: the roster is paged server-side (PAGE_SIZE per request) */
.ep-more {
  display: flex;
  justify-content: center;
  padding: 16px 0 4px;
}
.ep-more-btn {
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  background: var(--ui-surface);
  color: var(--ui-text-2);
  transition: background var(--ui-duration), border-color var(--ui-duration), color var(--ui-duration);
}
.ep-more-btn:hover:not(:disabled) {
  background: var(--ui-surface-2);
  border-color: var(--ui-accent);
  color: var(--ui-text);
}
.ep-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Cell renders */
.name {
  font-weight: 700;
  color: var(--ui-text);
}
.ep-none {
  color: var(--ui-text-muted);
}
.pos-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-badge {
  flex: none;
  /* A uniform badge width so the position text starts at the same x
     in every row regardless of the code length */
  min-width: 56px;
  text-align: center;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 700;
  line-height: 1.5;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  border: 1px solid color-mix(in srgb, var(--ui-accent) 25%, transparent);
}
</style>
