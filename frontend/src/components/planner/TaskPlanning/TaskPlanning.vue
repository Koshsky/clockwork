<script setup lang="ts">
import { computed, ref } from 'vue'
import CalendarHeader from '../CalendarHeader/CalendarHeader.vue'
import TimelineGrid from '../TimelineGrid/TimelineGrid.vue'
import { PlannerStates } from '@/components/common'
import ResourceHeader from '@/components/common/ResourceHeader/ResourceHeader.vue'
import TaskGantt from './components/TaskGantt/TaskGantt.vue'
import { provideDragPreview } from '@/composables/useDragPreview'
import type { DragPreviewState } from '@/composables/useDragPreview'
import type { DtoDetailedProcess, DtoResourceResponse, DtoResourceCalendar, DtoResourceAbsenceResponse, DtoUserInfo, DtoCommentResponse, DtoDetailedTask, DtoTaskDependency } from '@/api'
import type { Resource } from '@/components/common/ResourceHeader/types'
import type { Process } from './types'
import type { PlanningUnit } from '../calendar'
import type { DependencyType } from '../dependencies'
import { indexResourceDemand, indexedResourceUsage, indexResourcePeriods, resourceAvailableForDay } from '@/domain/resourceUsage'
import { shortName } from '@/utils'

const props = withDefaults(defineProps<{
  processes?: DtoDetailedProcess[] | null
  resources?: DtoResourceResponse[] | null
  resourceBadgeIds?: ReadonlySet<number>
  /** Resource availability (periods from /timesheet/calendar), "today ± 1 year" window */
  calendar?: DtoResourceCalendar[] | null
  /** Resource-member absences (for the UsageCell tooltip) by resource id */
  absenceByResource?: Record<number, DtoResourceAbsenceResponse[]> | null
  loading?: boolean
  error?: string | null
  /** Timeline anchor: cell with index 0 (starting position) */
  origin?: Date | string
  /** Cell unit: day or decade */
  unit?: PlanningUnit
  /** Allows modifying tasks and milestones: moving dates, editing, deleting */
  canManage?: boolean | ((taskId: number, processId: number) => boolean)
  canManageMilestones?: boolean | ((processId: number) => boolean)
  /** Enables vertical row drag to reorder tasks within each process */
  reorderable?: boolean | ((processId: number) => boolean)
  /** Users to display the owner (owner_id → name) in tooltips */
  users?: DtoUserInfo[] | null
  /** On open, scroll the timeline to this date (navigation from another tab) */
  focusDate?: string | null
  /** On open, scroll vertically to the group (process row) */
  focusGroupId?: string | number | null
  /** Per-task comment cache (for the badge and log in task tooltips) */
  commentsByTask?: Record<number, DtoCommentResponse[]> | null
}>(), {
  processes: null,
  resources: null,
  calendar: null,
  absenceByResource: null,
  loading: false,
  error: null,
  origin: '',
  unit: 'day',
  canManage: true,
  canManageMilestones: undefined,
  reorderable: false,
  users: null,
  focusDate: null,
  focusGroupId: null,
  commentsByTask: null,
})

function taskManager(processId: number): (id: number) => boolean {
  return (id) => typeof props.canManage === 'function' ? props.canManage(id, processId) : props.canManage
}

const emit = defineEmits<{
  change: [payload: { id: number; start_date: string; end_date: string }]
  'milestone-change': [payload: { id: number; date: string }]
  contextmenu: [payload: { clientX: number; clientY: number; date: string | null; rowIndex: number; processId?: number; taskId?: number; milestoneId?: number }]
  'header-ctxmenu': [payload: { clientX: number; clientY: number }]
  'milestone-edit': [payload: number]
  /** Vertical row drag: a task moved within its process group */
  reorder: [payload: { processId: number; from: number; to: number }]
  /** Visible timeline window (the "as on screen" period) — forwarded from TimelineGrid */
  'visible-range': [payload: { from: string; to: string; cellWidthPx: number; scale: number }]
  /** Click on a task bar — open the task editor */
  'edit': [payload: number]
  /** Task tooltip opened — lazily load comments (cache) */
  'request-comments': [payload: number]
  /** Click on the comments badge - open the comments panel */
  'open-comments': [payload: number]
}>()

/** Active task drag — for the live resource-load preview (written from TaskBar) */
const dragPreview = ref<DragPreviewState>({ active: false, taskId: null, startDate: null, endDate: null })
provideDragPreview(dragPreview)

/** Map the DTO (from /planning/tasks) into internal types. Tasks are sorted by
 *  their per-process order (fallback: id). */
const userById = computed(() => new Map((props.users || []).map((u) => [u.id ?? 0, u])))

const displayProcesses = computed<Process[]>(() =>
  (props.processes || []).map((dto) => ({
    id: dto.id ?? 0,
    title: dto.title ?? '',
    start_date: dto.start_date ?? '',
    end_date: dto.end_date ?? '',
    project_code: dto.project_code ?? '',
    tasks: [...(dto.tasks || [])]
      .sort((a, b) => (a.order ?? a.id ?? 0) - (b.order ?? b.id ?? 0))
      .map((t) => {
        const owner = t.owner_id != null ? userById.value.get(t.owner_id) : undefined
        const responsible = t.responsible_id != null ? userById.value.get(t.responsible_id) : undefined
        return {
          id: t.id ?? 0,
          title: t.title ?? '',
          color: t.color ?? '',
          start_date: t.start_date ?? '',
          end_date: t.end_date ?? '',
          owner_id: t.owner_id ?? null,
          owner_name: owner?.name,
          owner_short: owner ? shortName(owner) : undefined,
          responsible_id: t.responsible_id ?? null,
          responsible_name: responsible?.name,
          responsible_short: responsible ? shortName(responsible) : undefined,
          comments_count: t.comments_count ?? 0,
          status: t.status ?? 'not_started',
          subtasks: (t.subtasks || []).map((s: DtoDetailedTask) => ({
            id: s.id ?? 0,
            title: s.title ?? '',
            status: s.status ?? 'not_started',
          })),
          resources: (t.resources || []).map((r) => ({
            resource_id: r.id ?? 0,
            assignment_id: r.assignment_id ?? 0,
            quantity: r.quantity ?? 0,
            code: r.code ?? '',
            title: r.title ?? '',
            color: r.color ?? '',
          })),
        }
      }),
    milestones: (dto.milestones || []).map((m) => ({
      id: m.id ?? 0,
      title: m.title ?? '',
      content: m.content,
      color: m.color ?? '',
      date: m.date ?? '',
    })),
    dependencies: (dto.dependencies || []).map((e: DtoTaskDependency) => ({
      id: e.id ?? 0,
      task_id: e.task_id ?? 0,
      depends_on_task_id: e.depends_on_task_id ?? 0,
      type: e.type as DependencyType,
    })),
  })),
)

const displayResources = computed<Resource[]>(() =>
  (props.resources || []).map((r) => ({
    id: r.id ?? 0,
    code: r.code ?? '',
    title: r.title ?? '',
    employeesCount: r.employees_count ?? 0,
  })),
)

const periodByResource = computed(() => indexResourcePeriods(props.calendar ?? []))
const demandIndex = computed(() => indexResourceDemand(displayProcesses.value))

function availableForDay(resourceId: number, day: Date): number | null {
  return resourceAvailableForDay(periodByResource.value, resourceId, day)
}

function usageForDayPreview(resourceId: number, day: Date): number {
  return indexedResourceUsage(demandIndex.value, resourceId, day, dragPreview.value)
}

/** Right-click on empty space inside a process group — create a task/milestone in that process */
function onGridCtx(p: { clientX: number; clientY: number; date: string | null; rowIndex?: number; groupId?: string }) {
  const processId = p.groupId ? Number(p.groupId) : undefined
  emit('contextmenu', {
    clientX: p.clientX,
    clientY: p.clientY,
    date: p.date,
    rowIndex: p.rowIndex ?? 0,
    processId,
  })
}
</script>

<template>
  <PlannerStates :loading="loading" :error="error" :has-data="displayProcesses.length > 0">
    <TimelineGrid v-if="displayProcesses.length" id="task" :origin="origin" :unit="unit" :focus-date="focusDate" :focus-group-id="focusGroupId" @ctxmenu="onGridCtx" @header-ctxmenu="(p) => emit('header-ctxmenu', p)" @visible-range="(p) => emit('visible-range', p)">
      <template #default="{ t }">
        <CalendarHeader :t="t" />
        <ResourceHeader :t="t" :resources="displayResources" :usageFn="usageForDayPreview" :availableFn="availableForDay" :absence-by-resource="absenceByResource" />

        <TaskGantt
          v-for="proc in displayProcesses"
          :key="'proc' + proc.id"
          :timeline="t"
          :title="proc.title"
          :projectCode="proc.project_code"
          :processId="proc.id"
          :tasks="proc.tasks || []"
          :resource-badge-ids="resourceBadgeIds"
          :milestones="proc.milestones || []"
          :dependencies="proc.dependencies || []"
          :groupStartDate="proc.start_date"
          :groupEndDate="proc.end_date"
          :can-manage="typeof canManage === 'function' ? taskManager(proc.id) : canManage"
          :can-manage-milestones="typeof canManageMilestones === 'function' ? canManageMilestones(proc.id) : canManageMilestones"
          :reorderable="typeof reorderable === 'function' ? reorderable(proc.id) : reorderable"
          :users="users"
          :comments-by-task="commentsByTask"
          @change="(p) => emit('change', p)"
          @milestone-change="(p) => emit('milestone-change', p)"
          @contextmenu="(p) => emit('contextmenu', p)"
          @reorder="(p) => emit('reorder', { processId: proc.id, ...p })"
          @milestone-edit="(id) => emit('milestone-edit', id)"
          @edit="(id) => emit('edit', id)"
          @request-comments="(id) => emit('request-comments', id)"
          @open-comments="(id) => emit('open-comments', id)"
        />
      </template>
    </TimelineGrid>
  </PlannerStates>
</template>
