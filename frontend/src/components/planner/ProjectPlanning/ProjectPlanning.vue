<script setup lang="ts">
import { computed } from 'vue'
import { shortName } from '@/utils'
import { t } from '@/i18n'
import CalendarHeader from '../CalendarHeader/CalendarHeader.vue'
import TimelineGrid from '../TimelineGrid/TimelineGrid.vue'
import { PlannerStates } from '@/components/common'
import ProjectGantt from './components/ProjectGantt/ProjectGantt.vue'
import type { DtoProject, DtoUserInfo } from '@/api'
import type { PlanningUnit } from '../calendar'

const props = withDefaults(defineProps<{
  projects?: DtoProject[] | null
  loading?: boolean
  error?: string | null
  /** Timeline anchor: cell with index 0 (starting position) */
  origin?: Date | string
  /** Cell unit: day or decade */
  unit?: PlanningUnit
  /** Users to display the owner (owner_id → name) in tooltips */
  users?: DtoUserInfo[] | null
  /** Allows reordering rows (changing priorities) */
  reorderable?: boolean
  /** Check manage rights for a project */
  canManage?: (projectId: number) => boolean
  /** Whether the current user may create projects (affects the empty-state hint) */
  canCreate?: boolean
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
  reorderable: true,
  canManage: () => true,
  canCreate: true,
  focusDate: null,
  focusGroupId: null,
})

const emit = defineEmits<{
  change: [payload: { id: number; start_date: string; end_date: string }]
  contextmenu: [payload: { clientX: number; clientY: number; date: string | null; rowIndex: number; projectId?: number }]
  'header-ctxmenu': [payload: { clientX: number; clientY: number }]
  reorder: [payload: { from: number; to: number }]
  navigate: [payload: number]
  /** Empty state: create a new project (the page decides the dates) */
  create: []
  /** Visible timeline window (the "as on screen" period) — forwarded from TimelineGrid */
  'visible-range': [payload: { from: string; to: string; cellWidthPx: number; scale: number }]
}>()

const userNames = computed(() => new Map((props.users || []).map((u) => [u.id, u.name?.trim() || [u.last_name, u.first_name, u.middle_name].filter(Boolean).join(' ').trim()])))
const userShortNames = computed(() => new Map((props.users || []).map((u) => [u.id, shortName(u)])))

const displayProjects = computed(() =>
  (props.projects || []).map((dto) => ({
    id: dto.id ?? 0,
    project_code: dto.project_code ?? '',
    color: dto.color ?? '',
    start_date: dto.start_date ?? '',
    end_date: dto.end_date ?? '',
    priority: dto.priority,
    owner_name: dto.owner_id != null ? userNames.value.get(dto.owner_id) : undefined,
    owner_short: dto.owner_id != null ? userShortNames.value.get(dto.owner_id) : undefined,
    responsible_name: dto.responsible_id != null ? userNames.value.get(dto.responsible_id) : undefined,
    responsible_short: dto.responsible_id != null ? userShortNames.value.get(dto.responsible_id) : undefined,
  })),
)

/** Right-click on empty timeline space — create a project at the row position under the cursor */
function onGridCtx(p: { clientX: number; clientY: number; date: string | null; rowIndex?: number }) {
  emit('contextmenu', {
    clientX: p.clientX,
    clientY: p.clientY,
    date: p.date,
    rowIndex: p.rowIndex ?? 0,
  })
}
</script>

<template>
  <PlannerStates :loading="loading" :error="error" :has-data="displayProjects.length > 0">
    <!-- Empty DB: just a centered create-project action -->
    <template v-if="canCreate" #empty>
      <button type="button" class="pp-big" @click="emit('create')">{{ t('planner.projectPlanning.create') }}</button>
    </template>
    <TimelineGrid v-if="displayProjects.length" id="project" :origin="origin" :unit="unit" :focus-date="focusDate" :focus-group-id="focusGroupId" @ctxmenu="onGridCtx" @header-ctxmenu="(p) => emit('header-ctxmenu', p)" @visible-range="(p) => emit('visible-range', p)">
      <template #default="{ t }">
        <CalendarHeader :t="t" />
        <ProjectGantt
          :timeline="t"
          :projects="displayProjects"
          :reorderable="reorderable"
          :can-manage="canManage"
          @change="(p) => emit('change', p)"
          @contextmenu="(p) => emit('contextmenu', p)"
          @reorder="(p) => emit('reorder', p)"
          @navigate="(id) => emit('navigate', id)"
        />
      </template>
    </TimelineGrid>
  </PlannerStates>
</template>

<style scoped>
@import '../../../styles/tokens.css';
.pp-big {
  display: block;
  margin: 24px auto;
  padding: 16px 36px;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  border: none;
  border-radius: 10px;
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  cursor: pointer;
}
.pp-big:hover {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
</style>

