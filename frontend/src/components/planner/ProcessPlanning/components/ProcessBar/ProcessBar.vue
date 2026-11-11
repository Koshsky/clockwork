<script setup lang="ts">
import { computed } from 'vue'
import LabeledBar from '../../../Bar/Bar.vue'
import { BarTooltip } from '@/components/common'
import { t } from '@/i18n'
import { viewSettings } from '@/settings'
import type { ProcessBarProps } from './types'

const props = withDefaults(defineProps<ProcessBarProps>(), {
  projectCode: '',
  ownerName: '',
  color: 'var(--ui-gantt-process)',
  opacity: 0.85,
  draggable: true,
  groupStartDate: null,
  groupEndDate: null,
  height: 24,
  top: 1,
})

const emit = defineEmits<{
  change: [payload: { start_date: string; end_date: string }]
  contextmenu: [payload: { clientX: number; clientY: number }]
  click: []
}>()

/** Tooltip rows, rebuilt on a language switch */
const ownerRow = computed(() =>
  t('planner.bar.owner', { owner: props.ownerName }),
)
const responsibleRow = computed(() =>
  t('planner.bar.responsible', { name: props.responsibleName }),
)
</script>

<template>
  <LabeledBar
    :timeline="timeline"
    :startDate="startDate"
    :endDate="endDate"
    :groupStartDate="groupStartDate"
    :groupEndDate="groupEndDate"
    :title="title"
    :projectCode="viewSettings.badgeProcessProjectCode ? projectCode : undefined"
    :color="color || 'var(--ui-gantt-process)'"
    :opacity="opacity"
    :ownerShort="viewSettings.badgeProcessOwner ? ownerShort : undefined"
    :responsibleShort="viewSettings.badgeProcessResponsible ? responsibleShort : undefined"
    :ownerName="viewSettings.badgeProcessOwner ? ownerName : undefined"
    :responsibleName="viewSettings.badgeProcessResponsible ? responsibleName : undefined"
    :height="height"
    :top="top"
    :minWidth="40"
    padding="0 10px"
    :shadow="true"
    :draggable="draggable"
    :start-row-reorder="startRowReorder"
    @change="(d) => emit('change', d)"
    @contextmenu="(p) => emit('contextmenu', p)"
    @click="() => emit('click')"
  >
    <template #tooltip="{ dateRange }">
      <slot name="tooltip">
        <BarTooltip
          :title="title"
          :accent="color || 'var(--ui-gantt-process)'"
          :rows="[
            viewSettings.badgeProcessOwner && props.ownerName ? ownerRow : '',
            viewSettings.badgeProcessResponsible && props.responsibleName ? responsibleRow : '',
            dateRange,
          ].filter(Boolean)"
        />
      </slot>
    </template>
  </LabeledBar>
</template>
