<script setup lang="ts">
import { computed } from 'vue'
import { GroupGantt } from '../../../GroupGantt'
import { MilestoneMarker } from '../../../MilestoneMarker'
import TaskBar from './components/TaskBar/TaskBar.vue'
import { TaskDependencyLinks } from './components/TaskDependencyLinks'
import type { TaskGanttProps } from './types'
import { LABEL_WIDTH } from '../../../layout'
import { fmtDate as fmtDateLocale } from '@/i18n/date'

const props = withDefaults(defineProps<TaskGanttProps>(), {
  canManage: true,
  canManageMilestones: undefined,
  reorderable: false,
  users: null,
  commentsByTask: null,
  dependencies: () => [],
})

const emit = defineEmits<{
  change: [payload: { id: number; start_date: string; end_date: string }]
  'milestone-change': [payload: { id: number; date: string }]
  contextmenu: [payload: { clientX: number; clientY: number; date: string; rowIndex: number; processId?: number; taskId?: number; milestoneId?: number }]
  'milestone-edit': [payload: number]
  /** Vertical row drag: a task moved within its process group */
  reorder: [payload: { from: number; to: number }]
  /** Single click on a task bar — open the task editor */
  'edit': [payload: number]
  /** Task tooltip opened — lazy-load the comments (cache) */
  'request-comments': [payload: number]
  /** Click on the comments badge - open the comments panel */
  'open-comments': [payload: number]
}>()

const groupItems = computed(() => props.tasks)

/** Min merged label height: code (19px) + name (14px) + dates (11px) + padding ≈ 60px */
const MS_MIN_LABEL_HEIGHT = 64

function fmtDate(d: string | Date | number | null | undefined): string {
  return d ? fmtDateLocale(d) : ''
}

function onBarChange(id: number, d: { start_date: string; end_date: string }) {
  if (typeof props.canManage === 'function' ? props.canManage(id) : props.canManage) emit('change', { id, ...d })
}

function onBarContextMenu(p: { clientX: number; clientY: number }, id: number) {
  emit('contextmenu', { ...p, date: '', rowIndex: -1, processId: props.processId, taskId: id })
}

function onMilestoneContextMenu(p: { clientX: number; clientY: number }, id: number) {
  emit('contextmenu', { ...p, date: '', rowIndex: -1, processId: props.processId, milestoneId: id })
}

function onMilestoneEdit(id: number) {
  if (props.canManageMilestones ?? (props.canManage === true)) emit('milestone-edit', id)
}
</script>

<template>
  <div class="tg-task-group" :data-pdf-group="processId">
    <!-- Opaque sticky label-column cell for the milestone row (otherwise bars show through) -->
    <div class="tg-ms-label" :style="{ width: LABEL_WIDTH + 'px' }" />
    <!-- Dependency arrows between the process's top-level tasks -->
    <TaskDependencyLinks :timeline="timeline" :tasks="groupItems" :dependencies="dependencies" />
    <GroupGantt
      :timeline="timeline"
      :items="groupItems"
      :groupStartDate="groupStartDate"
      :groupEndDate="groupEndDate"
      :groupId="processId"
      :minLabelHeight="MS_MIN_LABEL_HEIGHT"
      :minRows="3"
      :reorderable="reorderable"
      mergedLabel
      @reorder="(p) => reorderable && emit('reorder', p)"
    >
      <template #label>
        <div v-if="projectCode" class="gl-code">{{ projectCode }}</div>
        <div class="gl-title">{{ title }}</div>
        <div v-if="groupStartDate && groupEndDate" class="gl-dates">
          {{ fmtDate(groupStartDate) }} — {{ fmtDate(groupEndDate) }}
        </div>
      </template>

      <template #bar="{ item, startReorder }">
        <TaskBar
          :timeline="timeline"
          :task="item"
          :resource-badge-ids="resourceBadgeIds"
          :projectCode="projectCode"
          :groupStartDate="groupStartDate"
          :groupEndDate="groupEndDate"
          :draggable="typeof canManage === 'function' ? canManage(item.id) : canManage"
          :start-row-reorder="reorderable ? startReorder : null"
          :users="users"
          :comments-by-task="commentsByTask"
          @change="(d) => onBarChange(item.id, d)"
          @contextmenu="(p) => onBarContextMenu(p, item.id)"
          @edit="(id) => emit('edit', id)"
          @request-comments="(id) => emit('request-comments', id)"
          @open-comments="(id) => emit('open-comments', id)"
        />
      </template>
    </GroupGantt>

    <MilestoneMarker
      v-for="ms in milestones"
      :key="ms.id"
      :timeline="timeline"
      :date="ms.date"
      :title="ms.title"
      :content="ms.content"
      :color="ms.color"
      :stripHeight="20"
      :groupStartDate="groupStartDate"
      :groupEndDate="groupEndDate"
      :draggable="canManageMilestones ?? (canManage === true)"
      @change="(d) => (canManageMilestones ?? (canManage === true)) && emit('milestone-change', { id: ms.id, ...d })"
      @contextmenu="(p) => onMilestoneContextMenu(p, ms.id)"
      @edit="() => onMilestoneEdit(ms.id)"
    />
  </div>
</template>

<style scoped>
@import "../../../../../styles/tokens.css";
.tg-task-group {
  position: relative;
  box-sizing: border-box;
  padding-top: 20px;
}
.tg-ms-label {
  position: sticky;
  left: 0;
  height: 20px;
  background: var(--ui-surface);
  /* Side panel — above the today line (--z-today) */
  z-index: var(--z-side-row);
  margin-top: -20px;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.gl-code {
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 800;
  line-height: 1.2;
  color: var(--ui-accent);
  letter-spacing: 0.3px;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gl-title {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 600;
  color: var(--ui-text-2);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gl-dates {
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 400;
  color: var(--ui-text-muted);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
