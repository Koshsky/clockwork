<script setup lang="ts">
import { computed, ref, type VNode } from 'vue'
import type { GroupGanttSlotItem, GroupGanttProps } from './types'
import { cellRangeForSpan } from '../calendar'
import { LABEL_WIDTH } from '../layout'
import { fmtDate } from '@/i18n/date'
import { useRowReorder } from '../../../composables/useRowReorder'

const props = withDefaults(defineProps<GroupGanttProps>(), {
  reorderable: false,
  mergedLabel: false,
  groupId: null,
  groupStartDate: null,
  groupEndDate: null,
  rowHeight: 26,
  minLabelHeight: 0,
  minRows: 0,
})

const groupEl = ref<HTMLElement | null>(null)

const emit = defineEmits<{
  reorder: [payload: { from: number; to: number }]
}>()

/** Group bounds backdrop on the timeline (one per group, behind the rows) */
const overlayStyle = computed(() => {
  const span = cellRangeForSpan(
    props.timeline.origin,
    props.timeline.unit,
    props.groupStartDate ?? '',
    props.groupEndDate ?? '',
  )
  if (!span) return null
  const t = props.timeline
  return {
    left: t.cellLeft(span.startCell) + 'px',
    width: (span.endCell - span.startCell) * t.cellPx + 'px',
  }
})

/** How many rows are rendered in the group: at least minRows (empty placeholder rows) */
const displayCount = computed(() => Math.max(props.items.length, props.minRows))

/** How many empty placeholder rows to add up to displayCount */
const emptyCount = computed(() => displayCount.value - props.items.length)

/** Merged label height = the whole group (rows of fixed height),
 *  but not less than minLabelHeight — so the code/name/dates do not shrink with 0-1 rows */
const mergedHeight = computed(() =>
  Math.max(displayCount.value * props.rowHeight, props.minLabelHeight) + 'px',
)

// === Vertical row drag (reorder): started from the row's bar (see #bar slot) ===
const { dropStyle, startRowDrag } = useRowReorder(
  () => props.items.length,
  () => props.reorderable,
  groupEl,
  (p) => emit('reorder', p),
)

defineSlots<{
  label(): VNode[]
  row(props: { item: GroupGanttSlotItem; index: number }): VNode[]
  /** startReorder — begin row reordering with the bar's pointerdown event */
  bar(props: { item: GroupGanttSlotItem; index: number; count: number; startReorder: (e: PointerEvent) => void }): VNode[]
}>()

function fmt(d: string | Date | number | null | undefined): string {
  return d ? fmtDate(d) : ''
}
</script>

<template>
  <div ref="groupEl" class="gg-group" :data-group="groupId ?? ''" :data-rows="displayCount" :data-pdf-min-height="minLabelHeight" :data-pdf-min-rows="minRows" :style="{ minHeight: mergedHeight, '--label-width': LABEL_WIDTH + 'px' }">
    <div v-if="overlayStyle" class="gg-overlay" :style="overlayStyle" />

    <!-- Merged group label (object code + process): sticky left, full height.
         Reordering is started by dragging the bar row itself (see #bar slot). -->
    <div
      v-if="mergedLabel"
      class="gg-merged"
      :style="{ width: LABEL_WIDTH + 'px', height: mergedHeight, marginBottom: '-' + mergedHeight }"
    >
      <slot name="label" />
    </div>

    <template v-for="(item, index) in items" :key="'gi' + item.id">
      <div class="gg-row" :style="{ height: rowHeight + 'px' }" :data-row-index="index" :data-pdf-row="item.id">
        <div v-if="!mergedLabel" class="gg-label" :style="{ width: LABEL_WIDTH + 'px' }">
          <slot name="row" :item="item as GroupGanttSlotItem" :index="index">
            <span class="item-title">{{ item.title }}</span>
            <div class="item-dates">{{ fmt(item.start_date) }} — {{ fmt(item.end_date) }}</div>
          </slot>
        </div>
        <div class="gg-bars">
          <slot
            name="bar"
            :item="item as GroupGanttSlotItem"
            :index="index"
            :count="items.length"
            :start-reorder="(e: PointerEvent) => startRowDrag(e, index)"
          />
        </div>
      </div>
    </template>

    <!-- Empty placeholder rows up to minRows: same group background, no bars -->
    <template v-for="i in emptyCount" :key="'ge' + (items.length + i)">
      <div class="gg-row" :style="{ height: rowHeight + 'px' }" :data-row-index="items.length + i - 1">
        <div v-if="!mergedLabel" class="gg-label" :style="{ width: LABEL_WIDTH + 'px' }" />
        <div class="gg-bars" />
      </div>
    </template>

    <div v-if="dropStyle" class="drop-line" :style="dropStyle" />
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.gg-group {
  position: relative;
}
/* Group divider across the full timeline width. Starts right after the side
 * panel (--label-width, set from LABEL_WIDTH by the template): in the label
 * column the line already exists (bottom borders of .gg-merged/.gg-label), so
 * without double borders a straight line results. Absolute positioning does not
 * add height to the groups. */
.gg-group::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--label-width, 0);
  right: 0;
  height: 1px;
  background: var(--ui-border);
  z-index: var(--z-content-top);
}
.gg-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--ui-overlay);
  pointer-events: none;
  z-index: var(--z-cell-overlay);
}
.gg-merged {
  position: sticky;
  left: 0;
  /* Width comes from LABEL_WIDTH through the inline style — never repeat the
     number here, the side panel is built from the same one. */
  background: var(--ui-surface);
  /* Side panel — above the today line (--z-today) */
  z-index: var(--z-side-merged);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  padding: 4px 12px;
  box-sizing: border-box;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.gg-row {
  position: relative;
}
.gg-label {
  position: sticky;
  left: 0;
  /* Width comes from LABEL_WIDTH through the inline style — never repeat the
     number here, the side panel is built from the same one. */
  height: 100%;
  background: var(--ui-surface);
  /* Side panel — above the today line (--z-today) */
  z-index: var(--z-side-row);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 500;
  color: var(--ui-text);
  padding: 1px 8px;
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  box-sizing: border-box;
  overflow: hidden;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.item-title {
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
.gg-bars {
  position: absolute;
  inset: 0;
  z-index: var(--z-bar);
}
.drop-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ui-drop);
  z-index: var(--z-drop-line);
  pointer-events: none;
}
</style>
