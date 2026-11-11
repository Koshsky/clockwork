<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  cellIndexForDate,
  cellStartDate,
  clampDateToBounds,
  fmtDate,
  toDate,
} from '../calendar'
import { useTimelineItem } from '../../../composables/useTimelineItem'
import { fmtDate as fmtDateLocale } from '@/i18n/date'
import { t } from '@/i18n'
import { TooltipCell } from '../../common/TooltipCell'
import { BarTooltip } from '../../common/Tooltips'
import type { MilestoneMarkerProps } from './types'

const props = withDefaults(defineProps<MilestoneMarkerProps>(), {
  color: 'var(--ui-milestone)',
  draggable: true,
  stripHeight: 20,
  groupStartDate: null,
  groupEndDate: null,
})

const emit = defineEmits<{
  change: [payload: { date: string }]
  contextmenu: [payload: { clientX: number; clientY: number }]
  /** Double click on the milestone — open editing */
  edit: []
}>()

const rootEl = ref<HTMLElement | null>(null)

/** Milestone date formatted for the tooltip (localized). Shows the STORED
 *  milestone date, not the containing cell's start: in decade mode the marker
 *  is snapped to its cell, but the label must represent the real date. */
const formattedDate = computed(() => fmtDateLocale(toDate(props.date)))

/** Milestone cell index */
const idx = computed(() =>
  cellIndexForDate(props.timeline.origin, props.timeline.unit, props.date),
)

const { visible, isDragging, cursor, previewStyle, startDrag, bounds } = useTimelineItem({
  timeline: () => props.timeline,
  groupStartDate: props.groupStartDate,
  groupEndDate: props.groupEndDate,
  getSpan: () => ({ startCell: idx.value, endCell: idx.value + 1 }),
  onCommit: (sp) => {
    const date = clampDateToBounds(
      fmtDate(cellStartDate(props.timeline.origin, props.timeline.unit, sp.startCell)),
      props.groupStartDate,
      props.groupEndDate,
    )
    emit('change', { date })
  },
})

/** Position and ray flag */
const pos = computed(() => {
  if (!visible.value) return null
  return {
    left: props.timeline.cellLeft(idx.value) + 'px',
    width: props.timeline.cellPx + 'px',
  }
})

const markerStyle = computed<Record<string, string | number> | null>(() => {
  if (!pos.value) return null
  return {
    background: props.color || 'var(--ui-milestone)',
    height: Math.max(props.stripHeight - 4, 8) + 'px',
    ...(props.draggable ? { cursor: cursor.value ?? 'pointer', touchAction: 'none' } : {}),
  }
})

const rayStyle = computed<Record<string, string | number> | null>(() => {
  if (!pos.value) return null
  return { background: props.color || 'var(--ui-milestone)', top: props.stripHeight + 'px' }
})

function onContextMenu(e: MouseEvent) {
  emit('contextmenu', { clientX: e.clientX, clientY: e.clientY })
}

function onPointerDown(e: PointerEvent) {
  if (props.draggable) startDrag(e, 'move')
}

function onDblClick() {
  emit('edit')
}

// === Keyboard move (accessibility) ===
// A draggable milestone is focusable and exposes the same date shift as the
// pointer drag: ←/→ move by one unit (a day, or a decade cell), Shift+←/→ by
// five such units, Alt+←/→ always by one DAY (fine-grained, in decade mode a
// cell step would move ten days). The shift is applied to the cell index and
// committed through the same `change` emit the drag uses.

/** Cells in one keyboard step: the timeline unit itself */
const moveStepCells = computed(() => (props.timeline.unit === 'decade' ? 3 : 1))

/** Accessible name of the milestone (role="slider") */
const ariaLabel = computed(() =>
  props.title
    ? t('planner.bar.milestoneNamed', { title: props.title, date: formattedDate.value })
    : t('planner.bar.milestone', { date: formattedDate.value }),
)

/** aria-value* bounds: the parent (process/project) span when it is known */
const ariaMin = computed(() =>
  bounds.value ? Math.min(bounds.value.startCell, bounds.value.endCell - 1) : undefined,
)
const ariaMax = computed(() => bounds.value?.endCell)
const ariaNow = computed(() => idx.value)

/** Keyboard move: Δ cells (negative — earlier), committed like a drag release */
function moveBy(deltaCells: number) {
  const date = clampDateToBounds(
    fmtDate(cellStartDate(props.timeline.origin, props.timeline.unit, idx.value + deltaCells)),
    props.groupStartDate,
    props.groupEndDate,
  )
  emit('change', { date })
}

/** Keyboard fine-step: a single calendar day in any unit (the a11y contract) */
function moveByDays(deltaDays: number) {
  const base = toDate(props.date)
  const date = clampDateToBounds(
    fmtDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + deltaDays)),
    props.groupStartDate,
    props.groupEndDate,
  )
  emit('change', { date })
}

function onKeydown(e: KeyboardEvent) {
  if (!props.draggable || e.ctrlKey || e.metaKey) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  if (e.altKey) {
    moveByDays(e.key === 'ArrowLeft' ? -1 : 1)
    return
  }
  const base = moveStepCells.value
  const step = e.shiftKey ? base * 5 : base
  moveBy(e.key === 'ArrowLeft' ? -step : step)
}
</script>

<template>
  <div
    v-if="pos"
    ref="rootEl"
    class="ms"
    :class="{ 'ms-drag': isDragging }"
    :style="previewStyle ?? pos"
  >
    <div
      class="ms-marker"
      :style="markerStyle"
      :tabindex="draggable ? 0 : undefined"
      :role="draggable ? 'slider' : undefined"
      :aria-label="draggable ? ariaLabel : undefined"
      :aria-valuemin="draggable ? ariaMin : undefined"
      :aria-valuemax="draggable ? ariaMax : undefined"
      :aria-valuenow="draggable ? ariaNow : undefined"
      :aria-valuetext="draggable ? formattedDate : undefined"
      @pointerdown="onPointerDown"
      @dblclick="onDblClick"
      @keydown="onKeydown"
      @contextmenu.prevent.stop="onContextMenu"
    >
      <TooltipCell :text="title" :multiline="true">
        <span class="ms-hit" />
        <template #popup>
          <BarTooltip
            :title="title"
            :accent="'var(--ui-milestone)'"
            :rows="[content, formattedDate].filter((x): x is string => Boolean(x))"
          />
        </template>
      </TooltipCell>
    </div>
    <div v-if="rayStyle" class="ms-ray" :style="rayStyle" />
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.ms {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: none;
  z-index: var(--z-content-top);
}
.ms-marker {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: 2px;
  width: 50%;
  min-width: 4px;
  border-radius: 4px;
  box-shadow: var(--ui-shadow-sm);
  cursor: default;
  pointer-events: auto;
}
.ms-drag .ms-marker {
  box-shadow: var(--ui-shadow-md);
}
/* Keyboard focus: the marker is a focusable slider, keep the outline visible */
.ms-marker:focus-visible {
  outline: 2px solid var(--ui-focus);
  outline-offset: 1px;
}
.ms-marker :deep(.tt-trigger) {
  display: flex;
  align-items: stretch;
  width: 100%;
  height: 100%;
  cursor: inherit;
}
.ms-hit {
  display: block;
  width: 100%;
}
.ms-ray {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: 2px;
  opacity: 0.9;
  pointer-events: none;
}
</style>
