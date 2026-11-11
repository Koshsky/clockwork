<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import ProjectPlanning from '../components/planner/ProjectPlanning/ProjectPlanning.vue'
import { PdfExport } from '../components/planner'
import type { PdfGanttGroup } from '../components/planner/PdfExport/pdfRenderer'
import { ContextMenu, ModalForm, ConfirmDialog } from '../components/common'
import type { ContextMenuItem } from '../components/common/ContextMenu'
import type { ModalField } from '../components/common/ModalForm'
import { useConfirm } from '../composables/useConfirm'
import { useContextMenu } from '../composables/useContextMenu'
import { compareByName, DAY_MS } from '../utils'
import { useEditModal } from '../composables/useEditModal'
import { usePlanningOrigin } from '../composables/usePlanningOrigin'
import { useUnitMenu } from '../composables/useUnitMenu'
import { useRoleAccess } from '../composables/useRoleAccess'
import { useFindPlanningItem } from '../composables/useFindPlanningItem'
import { usePlanningStore, useAppStore, useRbacStore } from '../store'
import { isOffline } from '../offline/state'
import { scheduleNamedRefresh } from '../offline/sync'
import { t } from '../i18n'
import { addDaysISO, fmtDate, toDate } from '../components/planner/calendar'
import { CELL_WIDTH } from '../components/planner/layout'
import { viewSettings } from '../settings'
import { isWorkerPreset } from '../rbac/presets'
import type { DtoProject } from '@/api'

const store = usePlanningStore()
const app = useAppStore()
const router = useRouter()
const { projectPlanning, loading, error } = storeToRefs(store)

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

/** Print model for PdfExport: one "Projects" group, rows = projects */
const projectGroups = computed<PdfGanttGroup[]>(() => {
  const rows = (projectPlanning.value?.projects ?? []).map((p: DtoProject) => ({
    id: p.id,
    title: p.project_code ?? '',
    start_date: p.start_date ?? '',
    end_date: p.end_date ?? '',
    project_id: p.id,
    owner_id: p.owner_id ?? undefined,
  }))
  return rows.length ? [{ id: 'projects', title: t('plannerViews.projects.pdfGroup'), rows }] : []
})

// Right-click menu on the table header: switching the "Day" / "Decade" scale
const { open: openUnitMenu, close: closeUnitMenu, select: selectUnit, bind: unitMenuBind } = useUnitMenu(unit)

// === Role permissions ===
// dp (project director): views and edits all projects, cannot delete
// rp (project manager): creates projects (becomes the owner), edits and deletes their own
const { role, userId, canCreateProject, canReorderProjects, canManageProject, canDeleteProject } = useRoleAccess()

const rbac = useRbacStore()
/** The owner field needs the matrix loaded; the preset is only a cold-start fallback. */
const permsReady = computed(() => rbac.permsLoaded || rbac.myPermissions.length > 0)
/** Changing the project owner — project.update with an unrestricted (all) scope. */
const canChangeProjectOwner = computed(() =>
  permsReady.value ? rbac.perm('project', 'update') === 'all' : role.value === 'admin',
)

const { findProject } = useFindPlanningItem()

// Right-click on an empty area: create-project menu (date under the cursor, inserted at the right-click position)
// Right-click on a project bar: edit/delete menu for the project
interface MenuState {
  x: number
  y: number
  date: string | null
  rowIndex: number
  projectId?: number
}
const menu = ref<MenuState | null>(null)

// Delete confirmation dialog (instead of window.confirm — it is blocked in iframes/sandboxes)
const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()

/** Transient success feedback (e.g. what the auto-create template added) */
const feedback = ref('')
let feedbackTimer: number | undefined
function showFeedback(text: string) {
  feedback.value = text
  if (feedbackTimer) window.clearTimeout(feedbackTimer)
  feedbackTimer = window.setTimeout(() => {
    feedback.value = ''
    feedbackTimer = undefined
  }, 6000)
}
onBeforeUnmount(() => {
  if (feedbackTimer) window.clearTimeout(feedbackTimer)
})

const menuItems = computed<ContextMenuItem[]>(() => {
  if (menu.value?.projectId != null) {
    const id = menu.value.projectId
    const items: ContextMenuItem[] = []
    if (canManageProject(id)) {
      items.push({ id: 'edit-project', label: t('plannerViews.projects.menu.edit') })
    }
    if (canDeleteProject(id)) {
      items.push({ id: 'delete-project', label: t('plannerViews.projects.menu.delete') })
    }
    return items
  }
  return canCreateProject.value
    ? [{ id: 'create-project', label: t('plannerViews.projects.menu.create') }]
    : []
})

const ownerOptions = computed(() =>
  app.users
    .filter((u) => !isWorkerPreset(u.preset))
    .sort(compareByName)
    .map((u) => ({ value: u.id ?? 0, label: u.name ?? '' })),
)

/** Candidates for the project "responsible" — own employees only (direct
 *  subordinates; admin — everyone), mirroring the task-assignee pool. */
const responsibleOptions = computed(() => {
  const options = [...app.myStaff]
    .sort(compareByName)
    .map((u) => ({ value: u.id ?? 0, label: u.name ?? '' }))
  return [{ value: 0, label: t('plannerViews.projects.field.noResponsible') }, ...options]
})

/** Duration in days from an inclusive date range (end - start + 1). */
function durationDaysOf(start: string, end: string): number {
  const startMs = toDate(start).getTime()
  const endMs = toDate(end).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 1
  return Math.round((endMs - startMs) / DAY_MS) + 1
}

// Project edit modal (code, color, dates, owner, responsible)
interface EditState {
  id: number
  code: string
  ownerId?: number
  responsibleId?: number
  color?: string
  startDate: string
  endDate: string
}
const { open: openEdit, close: closeEdit, submit: submitEdit, bind: editBind } = useEditModal<EditState>(
  (state) => {
    const fields: ModalField[] = [
      { key: 'code', label: t('plannerViews.projects.field.code'), type: 'text', value: state.code, required: true },
      { key: 'color', label: t('plannerViews.projects.field.color'), type: 'color', value: state.color ?? '' },
      { key: 'start_date', label: t('plannerViews.projects.field.startDate'), type: 'date', value: state.startDate, required: true },
      {
        key: 'end_date',
        label: t('plannerViews.projects.field.endDate'),
        type: 'date',
        value: state.endDate,
        required: true,
      },
      {
        key: 'duration_days',
        label: '',
        type: 'display',
        displayValue: (values) => {
          const start = String(values.start_date ?? state.startDate)
          const end = String(values.end_date ?? state.endDate)
          return t('plannerViews.projects.field.duration', { days: durationDaysOf(start, end) })
        },
      },
      {
        key: 'responsible_id',
        label: `${t('plannerViews.projects.field.responsible')} (${t('plannerViews.projects.field.responsibleHint')})`,
        type: 'select',
        value: state.responsibleId ?? 0,
        options: responsibleOptions.value,
      },
    ]
    // The project owner cannot be changed: the field is hidden unless the
    // matrix grants project.update with scope all
    if (canChangeProjectOwner.value) {
      fields.push({
        key: 'owner_id',
        label: t('plannerViews.projects.field.owner'),
        type: 'select',
        value: state.ownerId,
        options: ownerOptions.value,
      })
    }
    return fields
  },
  async (state, values) => {
    const patch: {
      code: string
      owner_id?: number
      responsible_id?: number
      color?: string
      start_date?: string
      end_date?: string
    } = { code: String(values.code ?? '') }
    // '' means "no custom color" → the backend stores NULL (standard color)
    patch.color = String(values.color ?? '')
    // Dates are picked directly in the calendar fields; duration is display-only.
    patch.start_date = String(values.start_date ?? state.startDate)
    patch.end_date = String(values.end_date ?? state.endDate)
    // 0 is the "clear responsible" sentinel (no responsible person).
    patch.responsible_id = values.responsible_id !== '' && values.responsible_id != null
      ? Number(values.responsible_id)
      : 0
    // The project owner cannot be changed: owner_id is sent only with the all scope
    if (canChangeProjectOwner.value && values.owner_id !== '' && values.owner_id != null) {
      patch.owner_id = Number(values.owner_id)
    }
    const ok = await store.updateProjectMeta(state.id, patch)
    return { ok, error: ok ? null : store.error }
  },
  () => t('plannerViews.projects.edit'),
  undefined,
  (state) => canManageProject(state.id),
)

function onContextMenu(p: { clientX: number; clientY: number; date: string | null; rowIndex: number; projectId?: number }) {
  // Project bar: open the menu only if there are rights to manage the project
  if (p.projectId != null) {
    if (!canManageProject(p.projectId) && !canDeleteProject(p.projectId)) return
    openMenu({ x: p.clientX, y: p.clientY, date: p.date, rowIndex: p.rowIndex, projectId: p.projectId })
    return
  }
  // Empty area: create menu only for roles with the create right and when the date is known
  if (!canCreateProject.value || p.date == null) return
  openMenu({ x: p.clientX, y: p.clientY, date: p.date, rowIndex: p.rowIndex })
}

/** Right-click on the table header — the "Day"/"Decade" scale menu (after closing the actions menu) */
function onHeaderCtx(p: { clientX: number; clientY: number }) {
  closeMenu()
  openUnitMenu(p.clientX, p.clientY)
}

const { open: openMenu, close: closeMenu, select, bind: menuBind } = useContextMenu(menu, menuItems, handleSelect)

function openProjectEdit(id: number) {
  const p = findProject(id)
  if (p) {
    const start = p.start_date ?? ''
    const end = p.end_date ?? ''
    openEdit({
      id,
      code: p.project_code ?? '',
      ownerId: p.owner_id,
      responsibleId: p.responsible_id,
      color: p.color ?? '',
      startDate: start,
      endDate: end,
    })
  }
}

/** Creates a project starting at the given date (shared by the toolbar button
 *  and the right-click menu); shows the auto-create template feedback. */
async function createProjectAt(date: string) {
  const res = await store.createProject({
    code: t('plannerViews.projects.defaultCodePrefix') + Date.now(),
    start_date: date,
    end_date: addDaysISO(date, viewSettings.defaultProjectDays),
  })
  // A failed creation is reported by the global toast (http.ts) — no inline banner.
  if (res.ok && res.autoCreated) {
    const a = res.autoCreated
    showFeedback(
      t('plannerViews.projects.autoCreated', {
        processes: a.processes,
        tasks: a.tasks,
        assignments: a.assignments,
      }),
    )
  }
}

async function handleSelect(id: string) {
  if (!menu.value || !menuItems.value.some((item) => item.id === id)) return
  const { date, projectId } = menu.value
  if (id === 'create-project' && date != null) {
    await createProjectAt(date)
  } else if (id === 'edit-project' && projectId != null) {
    openProjectEdit(projectId)
  } else if (id === 'delete-project' && projectId != null) {
    ask(t('plannerViews.projects.confirm.delete'), () => {
      void store.deleteProject(projectId)
    })
  }
}

async function onReorder(e: { from: number; to: number }) {
  // A failed reorder is reported by the global toast (http.ts) — no inline banner.
  await store.reorderProjects(e.from, e.to)
}

/** Click on a project bar — navigate to the processes tab anchored at the project start */
function goToProcesses(projectId: number) {
  router.push({ path: '/processes', query: { project: String(projectId) } })
}

onMounted(() => {
  store.loadProjectPlanning()
  if (!app.users.length) void app.loadUsers()
  // The responsible picker needs the "own staff" pool (direct subordinates).
  if (!app.myStaff.length) void app.loadMyStaff()
  // Page-entry SWR: render from cache instantly, then re-read the domains the
  // page displays while online (backend > cache) — own mutations and foreign
  // changes both land within one network round-trip.
  if (!isOffline.value) void scheduleNamedRefresh(['project-plan', 'projects', 'process-plan', 'myStaff'])
})
</script>

<template>
  <section class="pp">
    <!-- Printing the projects diagram as PDF: the period and cell width from the page -->
    <div class="pp-toolbar">
      <PdfExport
        :groups="projectGroups"
        :origin="origin"
        :unit="unit"
        :owner-id="userId"
        :role="role"
        scope="projects"
        :period-from="viewRange.from"
        :period-to="viewRange.to"
        :scale="viewRange.scale"
        :page-title="t('plannerViews.pdf.projects')"
      />
    </div>

    <p v-if="feedback" class="pp-fb" role="status">{{ feedback }}</p>

    <ProjectPlanning
      :projects="projectPlanning?.projects || []"
      :loading="loading"
      :error="error"
      :users="app.users"
      :origin="origin"
      :unit="unit"
      :reorderable="canReorderProjects"
      :can-manage="canManageProject"
      :can-create="canCreateProject"
      @change="(p) => store.updateProjectDates(p.id, p.start_date, p.end_date)"
      @contextmenu="onContextMenu"
      @header-ctxmenu="onHeaderCtx"
      @reorder="onReorder"
      @navigate="goToProcesses"
      @create="() => createProjectAt(fmtDate(new Date()))"
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
.pp-fb {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: var(--ui-success-soft);
  color: var(--ui-success);
  border: 1px solid color-mix(in srgb, var(--ui-success) 30%, transparent);
  border-radius: var(--ui-radius-sm);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}
.pp-st {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.er { color: var(--ui-danger); }
</style>
