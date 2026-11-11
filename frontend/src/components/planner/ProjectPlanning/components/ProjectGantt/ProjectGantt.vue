<script setup lang="ts">
import { computed } from 'vue'
import { GroupGantt } from '../../../GroupGantt'
import { PendingMark } from '@/components/common'
import ProjectBar from '../ProjectBar/ProjectBar.vue'
import type { ProjectGanttProps } from './types'

const props = withDefaults(defineProps<ProjectGanttProps>(), {
  reorderable: true,
  canManage: () => true,
})

const emit = defineEmits<{
  change: [payload: { id: number; start_date: string; end_date: string }]
  contextmenu: [payload: { clientX: number; clientY: number; date: string; rowIndex: number; projectId?: number }]
  reorder: [payload: { from: number; to: number }]
  /** Single click on a project bar — switch to that project's processes tab */
  navigate: [payload: number]
}>()

const groupItems = computed(() =>
  props.projects.map((p) => ({
    id: p.id,
    title: p.project_code || '',
    color: p.color || '',
    start_date: p.start_date || '',
    end_date: p.end_date || '',
    priority: p.priority,
    owner_name: p.owner_name,
    owner_short: p.owner_short,
    responsible_name: p.responsible_name,
    responsible_short: p.responsible_short,
  })),
)

function onBarChange(id: number, d: { start_date: string; end_date: string }) {
  emit('change', { id, ...d })
}

function onContextMenu(p: { clientX: number; clientY: number; id: number }) {
  emit('contextmenu', { ...p, date: '', rowIndex: -1, projectId: p.id })
}

/** Short Russian date for the row label (start — end) */
function fmt(d: string): string {
  if (!d) return ''
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}
</script>

<template>
  <GroupGantt
    :timeline="timeline"
    :items="groupItems"
    :reorderable="reorderable"
    :rowHeight="52"
    @reorder="(p) => emit('reorder', p)"
  >
    <!-- Row label: project code + the "awaiting sync" clock mark (pending queue) -->
    <template #row="{ item }">
      <span class="item-title">
        {{ item.title }}
        <PendingMark entity="project" :id="item.id" />
      </span>
      <div class="item-dates">{{ fmt(item.start_date) }} — {{ fmt(item.end_date) }}</div>
    </template>
    <template #bar="{ item, startReorder }">
      <ProjectBar
        :timeline="timeline"
        :startDate="item.start_date"
        :endDate="item.end_date"
        :projectCode="item.title"
        :priority="item.priority"
        :ownerName="item.owner_name"
        :ownerShort="item.owner_short"
        :responsibleName="item.responsible_name"
        :responsibleShort="item.responsible_short"
        :color="item.color"
        :draggable="canManage(item.id)"
        :start-row-reorder="reorderable ? startReorder : null"
        @change="(d) => onBarChange(item.id, d)"
        @contextmenu="(p) => onContextMenu({ ...p, id: item.id })"
        @click="() => emit('navigate', item.id)"
      />
    </template>
  </GroupGantt>
</template>

<style scoped>
/* Row label styling mirrors GroupGantt's default label (the #row slot is
   rendered from here, so the shared component's scoped classes do not reach it) */
.item-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 400;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-2);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-dates {
  font-size: calc(var(--ui-font-scale, 1) * 9px);
  color: var(--ui-text-muted);
  font-weight: 400;
  margin-top: 1px;
}
</style>
