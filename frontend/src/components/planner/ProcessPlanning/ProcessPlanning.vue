<script setup lang="ts">
import { computed } from 'vue'
import { shortName } from '@/utils'
import CalendarHeader from '../CalendarHeader/CalendarHeader.vue'
import TimelineGrid from '../TimelineGrid/TimelineGrid.vue'
import { PlannerStates } from '@/components/common'
import ProcessGantt from './components/ProcessGantt/ProcessGantt.vue'
import type { DtoDetailedProject, DtoUserInfo } from '@/api'
import type { PlanningUnit } from '../calendar'

const props = withDefaults(defineProps<{
  projects?: DtoDetailedProject[] | null
  loading?: boolean
  error?: string | null
  /** Timeline anchor: cell with index 0 (starting position) */
  origin?: Date | string
  /** Cell unit: day or decade */
  unit?: PlanningUnit
  /** Users to display the owner (owner_id → name) in tooltips */
  users?: DtoUserInfo[] | null
  /** Allows modifying processes: moving dates, editing, deleting */
  canManage?: boolean | ((processId: number) => boolean)
  /** Enables vertical row drag to reorder processes within each project */
  reorderable?: boolean | ((projectId: number) => boolean)
  /** On open, scroll the timeline to this date (navigation from another tab) */
  focusDate?: string | null
  /** On open, scroll vertically to the group (project row) */
  focusGroupId?: string | number | null
}>(), {
  projects: null,
  loading: false,
  error: null,
  origin: '',
  unit: 'day',
  users: null,
  canManage: true,
  reorderable: false,
  focusDate: null,
  focusGroupId: null,
})

const emit = defineEmits<{
  change: [payload: { id: number; start_date: string; end_date: string }]
  contextmenu: [payload: { clientX: number; clientY: number; date: string | null; rowIndex: number; projectId?: number; processId?: number }]
  'header-ctxmenu': [payload: { clientX: number; clientY: number }]
  /** Vertical row drag: a process moved within its project group */
  reorder: [payload: { projectId: number; from: number; to: number }]
  navigate: [payload: number]
  /** Visible timeline window (the "as on screen" period) — forwarded from TimelineGrid */
  'visible-range': [payload: { from: string; to: string; cellWidthPx: number; scale: number }]
}>()

const userNames = computed(() => new Map((props.users || []).map((u) => [u.id, u.name?.trim() || [u.last_name, u.first_name, u.middle_name].filter(Boolean).join(' ').trim()])))
const userShortNames = computed(() => new Map((props.users || []).map((u) => [u.id, shortName(u)])))

/** Map the DTO (from /planning/processes) into the internal type. Processes are
 *  sorted by their per-project order (fallback: id). */
const displayProjects = computed(() =>
  (props.projects || []).map((dto) => ({
    id: dto.id ?? 0,
    project_code: dto.project_code ?? '',
    start_date: dto.start_date ?? '',
    end_date: dto.end_date ?? '',
    priority: dto.priority,
    processes: [...(dto.processes || [])]
      .sort((a, b) => (a.order ?? a.id ?? 0) - (b.order ?? b.id ?? 0))
      .map((p) => ({
        id: p.id ?? 0,
        title: p.title ?? '',
        color: p.color ?? '',
        start_date: p.start_date ?? '',
        end_date: p.end_date ?? '',
        owner_id: p.owner_id,
        owner_name: p.owner_id != null ? userNames.value.get(p.owner_id) : undefined,
        owner_short: p.owner_id != null ? userShortNames.value.get(p.owner_id) : undefined,
        responsible_id: p.responsible_id,
        responsible_name: p.responsible_id != null ? userNames.value.get(p.responsible_id) : undefined,
        responsible_short: p.responsible_id != null ? userShortNames.value.get(p.responsible_id) : undefined,
        project_id: p.project_id,
        order: p.order,
      })),
  })),
)

/** Right-click on empty space inside a project group — create a process in that project */
function onGridCtx(p: { clientX: number; clientY: number; date: string | null; rowIndex?: number; groupId?: string }) {
  const projectId = p.groupId ? Number(p.groupId) : undefined
  emit('contextmenu', {
    clientX: p.clientX,
    clientY: p.clientY,
    date: p.date,
    rowIndex: p.rowIndex ?? 0,
    projectId,
  })
}
</script>

<template>
  <PlannerStates :loading="loading" :error="error" :has-data="displayProjects.length > 0">
    <TimelineGrid v-if="displayProjects.length" id="process" :origin="origin" :unit="unit" :focus-date="focusDate" :focus-group-id="focusGroupId" @ctxmenu="onGridCtx" @header-ctxmenu="(p) => emit('header-ctxmenu', p)" @visible-range="(p) => emit('visible-range', p)">
      <template #default="{ t }">
        <CalendarHeader :t="t" />
        <ProcessGantt
          v-for="project in displayProjects"
          :key="'proj' + project.id"
          :timeline="t"
          :projectCode="project.project_code"
          :projectId="project.id"
          :processes="project.processes"
          :groupStartDate="project.start_date"
          :groupEndDate="project.end_date"
          :can-manage="canManage"
          :reorderable="typeof reorderable === 'function' ? reorderable(project.id) : reorderable"
          @change="(p) => emit('change', p)"
          @contextmenu="(p) => emit('contextmenu', p)"
          @reorder="(p) => emit('reorder', { projectId: project.id, ...p })"
          @navigate="(id) => emit('navigate', id)"
        />
      </template>
    </TimelineGrid>
  </PlannerStates>
</template>

