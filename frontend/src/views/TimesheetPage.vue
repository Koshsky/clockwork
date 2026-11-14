<script setup lang="ts">
import { usePageReadRefresh } from '@/composables/usePageReadRefresh'
usePageReadRefresh(async () => { if (!ts.employees.length) await loadTimesheet(); else await ts.refreshEmployees(undefined, true, true) })
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { storeToRefs } from 'pinia'
import CalendarHeader from '../components/planner/CalendarHeader/CalendarHeader.vue'
import TimelineGrid from '../components/planner/TimelineGrid/TimelineGrid.vue'
import { PlannerStates } from '../components/common'
import { TimesheetGrid, stateBackground } from '../components/timesheet'
import type { AssignPayload, ClearPayload } from '../components/timesheet'
import { toDate } from '../components/planner/calendar'
import type { PlanningUnit } from '../components/planner/calendar'
import { useEmployeeFilters } from '../composables/useEmployeeFilters'
import { useRoleAccess } from '../composables/useRoleAccess'
import { useAppStore, useRbacStore, useTimesheetStore } from '../store'
import { isOffline, scheduleNamedRefresh } from '@/store/data/uiServices'
import { t as $t } from '../i18n'

import TimesheetDayTypes from './TimesheetDayTypes.vue'
import { dayTypesAccessible } from '../utils/timesheetAccess'

const ts = useTimesheetStore()
const { timesheetRows, states, loading, busy, error } = storeToRefs(ts)

const unit = ref<PlanningUnit>('day')
const origin = ref(toDate(new Date()))

const rbac = useRbacStore()
const canViewTimesheet = computed(() => rbac.can('worker', 'view'))
const canConfigureDayTypes = computed(() => dayTypesAccessible(rbac.can))
const showDayTypes = ref(false)
watch(canConfigureDayTypes, (allowed) => { if (!allowed) showDayTypes.value = false })
/** Permissions arrived (or were cached) — the matrix is authoritative; the preset is the cold-start fallback. */
const permsReady = computed(() => rbac.permsLoaded || rbac.myPermissions.length > 0)
/** "All employees" — when worker visibility is not restricted (scope all). */
const seesAllEmployees = computed(() =>
  permsReady.value ? rbac.perm('worker', 'view') === 'all' : role.value === 'admin',
)

const app = useAppStore()
const { users, resources } = storeToRefs(app)

const { role, canAssignEmployeeDays, canClearEmployeeDays } = useRoleAccess()

/** Resolve an employee row by id (for per-row permission predicates) */
function employeeById(id: number) {
  return visibleRows.value.find((e) => e.id === id)
}

/**
 * Shared employee filters (search / manager / resource) — synchronized with the
 * "Employees" page: the state is a single module-level source of truth.
 */
const {
  search,
  managerFilter,
  resourceFilter,
  managerFilterOptions,
  resourceFilterOptions,
  applyFilters,
} = useEmployeeFilters()

/** Rows shown in the grid: the roster filtered by the shared filters. */
const visibleRows = computed(() => applyFilters(timesheetRows.value))

async function loadTimesheet() {
  if (!canViewTimesheet.value) {
    showDayTypes.value = canConfigureDayTypes.value
    await ts.loadStates()
    return
  }
  await ts.loadStates()
  await ts.loadEmployees()
  // The filter options need the user/resource catalogs (cached in the app store)
  if (seesAllEmployees.value && !users.value.length) await app.loadUsers()
  await app.ensureResourceMembers(false)
  // Render is local-first (the cache hydrates instantly and the grid shows the
  // last known ranges), but the CURRENT ranges must come from the backend: pull
  // the visible window silently on open. Without this the timesheet kept stale
  // ranges until the user made an edit (periods were excluded from the
  // background cycle). refreshPeriods never toggles loading/warmup UI.
  if (ts.windowStart) void ts.refreshPeriods(ts.windowStart, ts.windowEnd)
  // Page-entry SWR (online): cache-first render, then re-read the roster (and
  // name catalogs) so user mutations done elsewhere show up immediately —
  // period refresh above only covers the already-visible rows.
  if (!isOffline.value) void scheduleNamedRefresh(['employees', 'users', 'myStaff'])
}
onMounted(loadTimesheet)
watch(canViewTimesheet, (allowed) => { if (allowed) void loadTimesheet() })

/** Lazy-load states on scroll/zoom (debounced) */
let rangeTimer: number | null = null
function onRange(p: { startDate: string; endDate: string }) {
  if (rangeTimer != null) clearTimeout(rangeTimer)
  rangeTimer = window.setTimeout(() => void ts.ensureRange(p.startDate, p.endDate), 250)
}
onBeforeUnmount(() => {
  if (rangeTimer != null) clearTimeout(rangeTimer)
})

async function onAssign(p: AssignPayload) {
  await ts.assignRange(p.employeeId, p.stateId, p.startDate, p.endDate)
}

async function onClear(p: ClearPayload) {
  await ts.clearRange(p.employeeId, p.startDate, p.endDate)
}

/**
 * "Load more" rows: appends the next roster page and pulls the states of the
 * new employees for the current window (the same per-employee request path the
 * window extension uses).
 */
async function onLoadMoreEmployees() {
  const ok = await ts.loadMoreEmployees()
  if (ok) await ts.refreshPeriods(ts.windowStart, ts.windowEnd)
}

/** state_id → user-defined color (custom overrides the palette fallback in
 *  the legend, the assignment swatches and every day cell). */
const stateColorMap = computed<Record<number, string>>(() => {
  const map: Record<number, string> = {}
  for (const st of states.value) {
    if (st.id != null && st.color) map[st.id] = st.color
  }
  return map
})
</script>

<template>
  <section class="tp">
    <div class="tp-head">
      <h2 class="tp-title">{{ $t('timesheet.page.title') }}</h2>
      <div v-if="canViewTimesheet" class="tp-legend">
        <span v-for="st in states" :key="'lg' + st.id" class="tp-legend-item">
          <span
            class="tp-swatch"
            :style="{ background: st.color ?? stateBackground(st.code, st.is_available, st.id) }"
          />
          {{ st.name }}
        </span>
      </div>
      <button v-if="canConfigureDayTypes" type="button" class="tp-day-types" :aria-expanded="showDayTypes" @click="showDayTypes = !showDayTypes">{{ $t('timesheet.page.dayTypes') }}</button>
      <span v-if="canViewTimesheet && seesAllEmployees" class="tp-note">{{ $t('timesheet.page.allEmployees') }}</span>
    </div>

    <TimesheetDayTypes v-if="showDayTypes && canConfigureDayTypes" />

    <div v-if="canViewTimesheet" class="tp-filters">
      <input v-model="search" type="search" class="tp-search" :placeholder="$t('timesheet.page.searchPlaceholder')" />
      <select v-if="seesAllEmployees" v-model="managerFilter" class="tp-filter">
        <option value="">{{ $t('timesheet.page.managerAll') }}</option>
        <option value="none">{{ $t('timesheet.page.managerNone') }}</option>
        <option v-for="u in managerFilterOptions" :key="u.id" :value="u.id">{{ u.name ?? `#${u.id}` }}</option>
      </select>
      <select v-if="resources.length" v-model="resourceFilter" class="tp-filter" :title="$t('timesheet.page.resourceFilterTitle')">
        <option value="">{{ $t('timesheet.page.resourceAll') }}</option>
        <option value="none">{{ $t('timesheet.page.resourceNone') }}</option>
        <option v-for="r in resourceFilterOptions" :key="r.id" :value="r.id">{{ r.code }} — {{ r.title }}</option>
      </select>
    </div>

    <PlannerStates v-if="canViewTimesheet" :loading="loading" :error="null" :has-data="timesheetRows.length > 0 || (!loading && !error)">
      <TimelineGrid
        id="timesheet"
        :origin="origin"
        :unit="unit"
        :focus-date="null"
      >
        <template #default="{ t }">
          <CalendarHeader :t="t" />
          <!--
            Like on the "Employees" page: when the roster is empty, the calendar
            header stays visible and the message is rendered inside the table.
            The box is constrained to the visible window (t.gridLeft +
            viewportCells * cellPx — the coordinates of the visible day cells),
            so the text stays centered in the grid area right of the sticky
            label strip instead of sliding right along the wide timeline content.
          -->
          <TimesheetGrid
            v-if="timesheetRows.length && visibleRows.length"
            :t="t"
            :employees="visibleRows"
            :states="states"
            :color-map="stateColorMap"
            :state-for-day="(id, iso) => ts.periodFor(id, iso)"
            :busy="busy"
            :can-assign="(id) => canAssignEmployeeDays(employeeById(id)?.manager_id)"
            :can-clear="(id) => canClearEmployeeDays(employeeById(id)?.manager_id)"
            @assign="onAssign"
            @clear="onClear"
            @range="onRange"
          />
          <p
            v-else
            class="tp-empty"
            :style="{
              marginLeft: t.gridLeft + 'px',
              width: t.viewportCells * t.cellPx + 'px',
            }"
          >
            {{ timesheetRows.length ? $t('timesheet.page.emptyFiltered') : $t('timesheet.page.emptyRoster') }}
          </p>
        </template>
      </TimelineGrid>
    </PlannerStates>

    <!-- Roster pagination: the backend returns PAGE_SIZE (50) employees plus a
         total; the rest is appended on demand, then their states are pulled. -->
    <div v-if="ts.employeesHasMore" class="tp-more">
      <button type="button" class="tp-more-btn" :disabled="ts.employeesLoadingMore" @click="onLoadMoreEmployees">
        {{ ts.employeesLoadingMore ? $t('common.loading') : $t('timesheet.page.more', { shown: timesheetRows.length, total: ts.employeesTotal }) }}
      </button>
    </div>

    <p v-if="error" class="tp-error">{{ error }}</p>
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.tp-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.tp-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.tp-search {
  width: 240px;
  box-sizing: border-box;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 9px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.tp-search:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.tp-filter {
  box-sizing: border-box;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 9px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.tp-filter:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.tp-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0;
}
.tp-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}
.tp-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-muted);
}
.tp-swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid var(--ui-border);
}
.tp-note {
  margin-left: auto;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-faint);
}
.tp-error {
  margin: 12px 0 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
}
/* "Load more" rows: the roster is paged server-side (PAGE_SIZE per request) */
.tp-more {
  display: flex;
  justify-content: center;
  padding: 16px 0 4px;
}
.tp-more-btn {
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
.tp-more-btn:hover:not(:disabled) {
  background: var(--ui-surface-2);
  border-color: var(--ui-accent);
  color: var(--ui-text);
}
.tp-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.tp-empty {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 40px 12px;
  text-align: center;
  box-sizing: border-box;
}
.tp-day-types { border: 1px solid var(--ui-border-strong); background: var(--ui-surface); color: var(--ui-text-2); border-radius: var(--ui-radius-sm); padding: 7px 12px; font: inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); cursor: pointer; }
.tp-day-types:hover, .tp-day-types[aria-expanded="true"] { color: var(--ui-accent); border-color: var(--ui-accent); }
</style>
