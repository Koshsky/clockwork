<script setup lang="ts">
import { usePageReadRefresh } from '@/composables/usePageReadRefresh'
usePageReadRefresh(async () => { await store.refreshProcessPlanning(store.processPlanning != null, true) })
import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import ProcessPlanning from '../components/planner/ProcessPlanning/ProcessPlanning.vue'
import { PdfExport } from '../components/planner'
import type { PdfGanttGroup } from '../components/planner/PdfExport/pdfRenderer'
import { ContextMenu, ModalForm, ConfirmDialog } from '../components/common'
import type { ContextMenuItem } from '../components/common/ContextMenu'
import { useConfirm } from '../composables/useConfirm'
import { useContextMenu } from '../composables/useContextMenu'
import { useEditModal } from '../composables/useEditModal'
import { usePlanningOrigin } from '../composables/usePlanningOrigin'
import { useUnitMenu } from '../composables/useUnitMenu'
import { compareByName, DAY_MS } from '../utils'
import { useRoleAccess } from '../composables/useRoleAccess'
import { useFindPlanningItem } from '../composables/useFindPlanningItem'
import { usePlanningStore, useAppStore } from '../store'
import { isOffline, scheduleNamedRefresh } from '@/store/data/uiServices'
import { t } from '../i18n'
import { addMonthsISO, fitSpanDates, toDate } from '../components/planner/calendar'
import { CELL_WIDTH } from '../components/planner/layout'
import { isWorkerPreset } from '../rbac/presets'
import type { DtoDetailedProject, DtoProcess } from '@/api'

const store = usePlanningStore()
const app = useAppStore()
const router = useRouter()
const route = useRoute()
const { processPlanning, loading, error } = storeToRefs(store)

const { unit, origin } = usePlanningOrigin()

/** Current visible timeline window (the period "as on screen") + zoom — for PDF export */
const viewRange = ref<{ from: string; to: string; cellWidthPx: number; scale: number }>({
  from: '',
  to: '',
  cellWidthPx: CELL_WIDTH,
  scale: 1,
})
function onVisibleRange(v: { from: string; to: string; cellWidthPx: number; scale: number }) {
  viewRange.value = v
}

/** Print model for PdfExport: a project = a group, processes = rows */
const processGroups = computed<PdfGanttGroup[]>(() =>
  (processPlanning.value?.projects ?? []).map((project: DtoDetailedProject) => ({
    id: project.id,
    code: project.project_code ?? '',
    title: '',
    start_date: project.start_date ?? '',
    end_date: project.end_date ?? '',
    project_id: project.id,
    rows: (project.processes ?? []).map((p: DtoProcess) => ({
      id: p.id,
      title: p.title ?? '',
      start_date: p.start_date ?? '',
      end_date: p.end_date ?? '',
      project_id: p.project_id ?? project.id,
      owner_id: p.owner_id ?? undefined,
    })),
  })),
)

// Right-click menu on the table header: switching the "Day" / "Decade" scale
const { open: openUnitMenu, close: closeUnitMenu, select: selectUnit, bind: unitMenuBind } = useUnitMenu(unit)

const { canCreateProcessInProject, canManageProcess, canDeleteProcess, canReorderProcess, role, userId } = useRoleAccess()

const { findProcess } = useFindPlanningItem()

/** Timeline anchor when navigating from the projects tab (click on a project bar) */
const focusDate = computed(() => {
  const id = Number(route.query.project)
  if (!id) return null
  const project = store.processPlanning?.projects?.find((p: DtoDetailedProject) => p.id === id)
  return project?.start_date ?? null
})

/** Vertical scroll to the project group (row) */
const focusGroupId = computed(() => {
  const id = Number(route.query.project)
  return id ? id : null
})

/** Click on a process bar — navigate to the tasks tab anchored at the first days of the process */
function goToTasks(processId: number) {
  router.push({ path: '/planner', query: { process: String(processId) } })
}

// Right-click on an empty group area: create a process in the parent project.
// The date is under the cursor, the row is inserted at the right-click position.
// Right-click on a process bar: edit/delete menu for the process.
interface MenuState {
  x: number
  y: number
  date: string | null
  rowIndex: number
  projectId?: number
  processId?: number
}
const menu = ref<MenuState | null>(null)

// Delete confirmation dialog (instead of window.confirm — it is blocked in iframes/sandboxes)
const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()

const menuItems = computed<ContextMenuItem[]>(() => {
  if (menu.value?.processId == null) {
    return canCreateProcessInProject(menu.value?.projectId) ? [{ id: 'create-process', label: t('plannerViews.processes.menu.create') }] : []
  }
  const processId = menu.value.processId
  const items: ContextMenuItem[] = []
  if (canManageProcess(processId)) items.push({ id: 'edit-process', label: t('plannerViews.processes.menu.edit') })
  if (canDeleteProcess(processId)) items.push({ id: 'delete-process', label: t('plannerViews.processes.menu.delete') })
  return items
})

const ownerOptions = computed(() =>
  app.users
    .filter((u) => !isWorkerPreset(u.preset))
    .sort(compareByName)
    .map((u) => ({ value: u.id ?? 0, label: u.name ?? '' })),
)

/** Candidates for the process "responsible" — own employees only (direct
 *  subordinates; admin — everyone), mirroring the project/task pool. */
const responsibleOptions = computed(() => {
  const options = [...app.myStaff]
    .sort(compareByName)
    .map((u) => ({ value: u.id ?? 0, label: u.name ?? '' }))
  return [{ value: 0, label: t('plannerViews.processes.field.noResponsible') }, ...options]
})

/** Duration in days from an inclusive date range (end - start + 1). */
function durationDaysOf(start: string, end: string): number {
  const startMs = toDate(start).getTime()
  const endMs = toDate(end).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 1
  return Math.round((endMs - startMs) / DAY_MS) + 1
}

// Process edit modal (title, color, dates, owner, responsible)
interface EditState {
  id: number
  title: string
  ownerId?: number
  responsibleId?: number
  color?: string
  startDate: string
  endDate: string
}
const { open: openEdit, close: closeEdit, submit: submitEdit, bind: editBind } = useEditModal<EditState>(
  (state) => [
    { key: 'title', label: t('plannerViews.processes.field.title'), type: 'text', value: state.title, required: true },
    { key: 'color', label: t('plannerViews.processes.field.color'), type: 'color', value: state.color ?? '' },
    { key: 'start_date', label: t('plannerViews.processes.field.startDate'), type: 'date', value: state.startDate, required: true },
    { key: 'end_date', label: t('plannerViews.processes.field.endDate'), type: 'date', value: state.endDate, required: true },
    {
      key: 'duration_days',
      label: '',
      type: 'display',
      displayValue: (values) => {
        const start = String(values.start_date ?? state.startDate)
        const end = String(values.end_date ?? state.endDate)
        return t('plannerViews.processes.field.duration', { days: durationDaysOf(start, end) })
      },
    },
    { key: 'owner_id', label: t('plannerViews.processes.field.owner'), type: 'select', value: state.ownerId, options: ownerOptions.value },
    {
      key: 'responsible_id',
      label: `${t('plannerViews.processes.field.responsible')} (${t('plannerViews.processes.field.responsibleHint')})`,
      type: 'select',
      value: state.responsibleId ?? 0,
      options: responsibleOptions.value,
    },
  ],
  async (state, values) => {
    const ownerId = values.owner_id !== '' ? Number(values.owner_id) : undefined
    const responsibleId = values.responsible_id !== '' && values.responsible_id != null
      ? Number(values.responsible_id)
      : 0
    const ok = await store.updateProcessMeta(state.id, {
      title: String(values.title ?? ''),
      color: String(values.color ?? ''),
      owner_id: ownerId,
      responsible_id: responsibleId,
      start_date: String(values.start_date ?? state.startDate),
      end_date: String(values.end_date ?? state.endDate),
    })
    return { ok, error: ok ? null : store.error }
  },
  () => t('plannerViews.processes.edit'),
  undefined,
  (state) => canManageProcess(state.id),
)

function onContextMenu(p: { clientX: number; clientY: number; date: string | null; rowIndex: number; projectId?: number; processId?: number }) {
  // Empty group area: creating a process requires the create right, a parent project and a known date
  if (p.processId == null) {
    if (!canCreateProcessInProject(p.projectId)) return
    if (p.projectId == null || p.date == null) return
  } else if (!canManageProcess(p.processId) && !canDeleteProcess(p.processId)) {
    return
  }
  openMenu({ x: p.clientX, y: p.clientY, date: p.date, rowIndex: p.rowIndex, projectId: p.projectId, processId: p.processId })
}

/** Right-click on the table header — the "Day"/"Decade" scale menu (after closing the actions menu) */
function onHeaderCtx(p: { clientX: number; clientY: number }) {
  closeMenu()
  openUnitMenu(p.clientX, p.clientY)
}

const { open: openMenu, close: closeMenu, select, bind: menuBind } = useContextMenu(menu, menuItems, handleSelect)

function openProcessEdit(id: number) {
  const proc = findProcess(id)
  if (proc) {
    const start = proc.start_date ?? ''
    const end = proc.end_date ?? ''
    openEdit({
      id,
      title: proc.title ?? '',
      ownerId: proc.owner_id,
      responsibleId: proc.responsible_id,
      color: proc.color ?? '',
      startDate: start,
      endDate: end,
    })
  }
}

async function handleSelect(id: string) {
  if (!menu.value || !menuItems.value.some((item) => item.id === id)) return
  const { date, rowIndex, projectId, processId } = menu.value
  if (id === 'create-process') {
    if (projectId == null || date == null) return
    const project = store.processPlanning?.projects?.find((p: DtoDetailedProject) => p.id === projectId)
    // A process starts exactly in the cell the user right-clicked and keeps the default
    // length; near the project end the length is truncated by the project end (the
    // start never slides left), and a click outside the project is clamped to it.
    const { start_date, end_date } = fitSpanDates(
      date,
      addMonthsISO(date, 3),
      project?.start_date,
      project?.end_date,
    )
    await store.createProcess({
      title: t('plannerViews.processes.defaultTitle'),
      project_id: projectId,
      start_date,
      end_date,
    }, rowIndex)
    // A failed creation is reported by the global toast (http.ts) — no inline banner.
  } else if (id === 'edit-process' && processId != null) {
    openProcessEdit(processId)
  } else if (id === 'delete-process' && processId != null) {
    ask(t('plannerViews.processes.confirm.delete'), () => {
      void store.deleteProcess(processId)
    })
  }
}

onMounted(() => {
  store.loadProcessPlanning()
  if (!app.users.length) void app.loadUsers()
  // The responsible picker needs the "own staff" pool (direct subordinates).
  if (!app.myStaff.length) void app.loadMyStaff()
  // Page-entry SWR (online): cache-first render, then re-read the process
  // aggregate and its parent project bars so recent mutations show up
  // immediately.
  if (!isOffline.value) void scheduleNamedRefresh(['process-plan', 'project-plan', 'myStaff'])
})
</script>

<template>
  <section class="pp">
    <!-- Printing the processes diagram as PDF: the period and cell width from the page -->
    <div class="pp-toolbar">
      <PdfExport
        :groups="processGroups"
        :origin="origin"
        :unit="unit"
        :owner-id="userId"
        :role="role"
        scope="processes"
        :period-from="viewRange.from"
        :period-to="viewRange.to"
        :scale="viewRange.scale"
        :page-title="t('plannerViews.pdf.processes')"
      />
    </div>

    <ProcessPlanning
      :projects="processPlanning?.projects || []"
      :loading="loading"
      :error="error"
      :users="app.users"
      :origin="origin"
      :unit="unit"
      :can-manage="canManageProcess"
      :reorderable="(id) => canReorderProcess(processPlanning?.projects?.find((p) => p.id === id)?.owner_id)"
      :focus-date="focusDate"
      :focus-group-id="focusGroupId"
      @change="(p) => store.updateProcessDates(p.id, p.start_date, p.end_date)"
      @contextmenu="onContextMenu"
      @header-ctxmenu="onHeaderCtx"
      @reorder="(p) => void store.reorderProcesses(p.projectId, p.from, p.to)"
      @navigate="goToTasks"
      @visible-range="onVisibleRange"
    />

    <ContextMenu v-bind="menuBind" @select="select" @close="closeMenu" />

    <ContextMenu v-bind="unitMenuBind" @select="selectUnit" @close="closeUnitMenu" />

    <ConfirmDialog
      :open="!!confirmDialog"
      :message="confirmDialog?.message ?? ''"
      :confirm-label="confirmDialog?.confirmLabel"
      @confirm="proceed"
      @close="cancel"
    />

    <ModalForm v-bind="editBind" @save="submitEdit" @close="closeEdit" />
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.pp {
  /* Diagram fills the exact viewport height; the page never scrolls —
     only the timeline does (rows vertical, calendar horizontal). */
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  --planner-max-height: calc(100dvh - 112px);
}

/* PlannerStates (.pg) + timeline as a flex column: tg-scroll fills the rest */
.pp :deep(.pg) {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pp :deep(.tg-scroll) {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
}

.pp-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
  flex: none;
}
.pp-st {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.er { color: var(--ui-danger); }
</style>
