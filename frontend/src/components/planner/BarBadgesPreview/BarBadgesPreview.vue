<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import ProjectBar from '../ProjectPlanning/components/ProjectBar/ProjectBar.vue'
import ProcessBar from '../ProcessPlanning/components/ProcessBar/ProcessBar.vue'
import { TaskBar } from '../TaskPlanning/components/TaskGantt/components/TaskBar'
import { cellRangeForSpan } from '../calendar'
import { makeDemoTimeline } from '../demoTimeline'
import type { BadgePreviewTask } from './types'

// Use the real bars so settings previews cannot drift from the planner.
const props = withDefaults(defineProps<{ kind?: 'project' | 'process' | 'task' }>(), {
  kind: 'task',
})

const ORIGIN = '2026-01-01'
const CELL_PX = 38
// Leave enough space for the title when every badge is enabled.
const START_DATE = '2026-01-01'
const END_DATE = '2026-01-14'
const PROJECT_CODE = 'KO-1001'

const timeline = makeDemoTimeline(ORIGIN, 'day', { cellPx: CELL_PX, viewportCells: 16 })

/** Bar width from the planner's own span math, so the frame always fits it. */
const barWidth = computed(() => {
  const span = cellRangeForSpan(ORIGIN, 'day', START_DATE, END_DATE)
  return span ? (span.endCell - span.startCell) * CELL_PX : 0
})

const task = computed<BadgePreviewTask>(() => ({
  id: -1,
  title: t('adminSystem.settings.badges.demoTitle'),
  start_date: START_DATE,
  end_date: END_DATE,
  resources: [
    { resource_id: 1, assignment_id: 1, quantity: 2, code: 'MK', color: '#1A73E8' },
    { resource_id: 2, assignment_id: 2, quantity: 1, code: 'SV' },
  ],
  owner_short: t('adminSystem.settings.badges.demoOwner'),
  owner_name: t('adminSystem.settings.badges.demoOwner'),
  responsible_short: t('adminSystem.settings.badges.demoResponsible'),
  responsible_name: t('adminSystem.settings.badges.demoResponsible'),
  // One of two operations done — the progress badge shows 50%.
  subtasks: [
    { id: -1, status: 'done' },
    { id: -2, status: 'in_progress' },
  ],
  comments_count: 3,
}))
</script>

<template>
  <div class="bbp-preview" :data-kind="kind">
    <div class="bbp-row" :style="{ width: barWidth + 'px', height: props.kind === 'project' ? '52px' : '26px' }">
      <ProjectBar
        v-if="kind === 'project'"
        :timeline="timeline"
        :start-date="START_DATE"
        :end-date="END_DATE"
        :project-code="PROJECT_CODE"
        :owner-name="t('adminSystem.settings.badges.demoOwner')"
        :responsible-name="t('adminSystem.settings.badges.demoResponsible')"
        :draggable="false"
      />
      <ProcessBar
        v-else-if="kind === 'process'"
        :timeline="timeline"
        :start-date="START_DATE"
        :end-date="END_DATE"
        :title="t('adminSystem.settings.badges.demoTitle')"
        :project-code="PROJECT_CODE"
        :owner-name="t('adminSystem.settings.badges.demoOwner')"
        :responsible-name="t('adminSystem.settings.badges.demoResponsible')"
        :draggable="false"
      />
      <TaskBar
        v-else
        :timeline="timeline"
        :task="task"
        :project-code="PROJECT_CODE"
        :draggable="false"
      />
    </div>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.bbp-preview {
  box-sizing: border-box;
  width: 100%;
  overflow-x: auto;
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
}
/* The bar positions itself absolutely: the row is its positioning context. */
.bbp-row {
  position: relative;
  height: 26px;
}
</style>
