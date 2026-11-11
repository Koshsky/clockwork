<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useSlots, watch } from 'vue'
import { cellRangeForSpan, clampSpanDates, spanToDates, formatDateRange, fmtDate, toDate } from '../calendar'
import { useTimelineItem } from '../../../composables/useTimelineItem'
import { useWindowPointerTrack } from '../../../utils'
import { TooltipCell } from '../../common'
import { t } from '@/i18n'
import { shortName } from '@/utils'
import type { BarProps } from './types'

const slots = useSlots()

const props = withDefaults(defineProps<BarProps>(), {
  title: '',
  projectCode: '',
  color: 'var(--ui-gantt-task)',
  opacity: 0.75,
  tooltip: '',
  height: 24,
  top: 1,
  minWidth: 4,
  padding: '0 8px',
  shadow: false,
  draggable: true,
  groupStartDate: null,
  groupEndDate: null,
})

const ownerLabel = computed(() => (props.ownerName || props.ownerShort)
  ? props.ownerShort ?? shortName({ name: props.ownerName }) : '')
const responsibleLabel = computed(() => (props.responsibleName || props.responsibleShort)
  ? props.responsibleShort ?? shortName({ name: props.responsibleName }) : '')

const emit = defineEmits<{
  change: [payload: { start_date: string; end_date: string }]
  contextmenu: [payload: { clientX: number; clientY: number }]
  /** Single click (without dragging) — navigation between tabs */
  click: []
  /** Drag/resize start: proposed new dates (live loading preview) */
  dragstart: [payload: { start_date: string; end_date: string }]
  /** Drag continues — new dates updated */
  dragmove: [payload: { start_date: string; end_date: string }]
  /** Drag finished (any way) — reset the preview */
  dragend: []
  /** Bar tooltip became visible — for lazy loading of related data */
  'tooltip-open': []
  /** A keyboard action started a date change (arrows): the proposed dates, same
   *  contract as `dragstart` — for the live loading preview. */
  keyboardmove: [payload: { start_date: string; end_date: string }]
}>()

// === Distinguishing a single click from a double click ===
// A single click starts a short timer (120ms); if a second click arrives (dblclick) —
// the timer is cancelled and the double click does nothing. This lets a click on a bar
// navigate between tabs quickly without firing on a double click.
const CLICK_DELAY_MS = 120
const CLICK_MOVE_PX = 4
let clickTimer: ReturnType<typeof setTimeout> | null = null
const downPos = ref<{ x: number; y: number } | null>(null)

// === Body press: vertical reorder vs horizontal date drag ===
// With a reorderable row (startRowReorder is provided) the press on the bar body
// is not committed to the date drag immediately: the dominant movement axis
// decides — vertical → row reorder, horizontal → date drag as before.
const REORDER_AXIS_PX = 8
let pressStart: { x: number; y: number; e: PointerEvent } | null = null

const pressTrack = useWindowPointerTrack({
  onMove: (e) => {
    if (!pressStart) return
    const dx = e.clientX - pressStart.x
    const dy = e.clientY - pressStart.y
    if (Math.abs(dx) < REORDER_AXIS_PX && Math.abs(dy) < REORDER_AXIS_PX) return
    const start = pressStart
    pressStart = null
    pressTrack.stop()
    if (Math.abs(dy) > Math.abs(dx)) {
      // Vertical — row reorder (with the bar's own pointerdown event)
      start.e.preventDefault()
      start.e.stopPropagation()
      props.startRowReorder?.(start.e)
    } else if (props.draggable) {
      // Horizontal — regular date drag
      startDrag(start.e, 'move')
    }
  },
  onUp: () => {
    pressStart = null
    pressTrack.stop()
  },
  onCancel: () => {
    pressStart = null
    pressTrack.stop()
  },
})

function onBodyPointerDown(e: PointerEvent) {
  if (e.button === 0) downPos.value = { x: e.clientX, y: e.clientY }
  if (props.startRowReorder) {
    // Axis disambiguation pending — the drag starts once the move direction is clear
    pressStart = { x: e.clientX, y: e.clientY, e }
    pressTrack.start()
    return
  }
  if (props.draggable) startDrag(e, 'move')
}

function onPointerUp(e: PointerEvent) {
  const p = downPos.value
  downPos.value = null
  if (!p || e.button !== 0) return
  // There was movement (drag/resize) — this is not a click.
  if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) >= CLICK_MOVE_PX) return
  // A timer already exists — this is the second click of a double click: suppress navigation, wait for dblclick.
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
    return
  }
  clickTimer = setTimeout(() => {
    clickTimer = null
    emit('click')
  }, CLICK_DELAY_MS)
}

onBeforeUnmount(() => {
  if (clickTimer) clearTimeout(clickTimer)
})

/** Whether there is a custom tooltip: via the `tooltip` prop or the `#tooltip` slot */
const hasTooltip = computed(() => Boolean(props.tooltip) || Boolean(slots.tooltip))

const span = computed(() =>
  cellRangeForSpan(props.timeline.origin, props.timeline.unit, props.startDate, props.endDate),
)

const { bounds, visible, isDragging, cursor, previewStyle, dragSpan, startDrag } = useTimelineItem({
  timeline: () => props.timeline,
  groupStartDate: props.groupStartDate,
  groupEndDate: props.groupEndDate,
  getSpan: () => span.value,
  onCommit: (sp) => {
    const d = spanToDates(props.timeline.origin, props.timeline.unit, sp.startCell, sp.endCell)
    emit('change', clampSpanDates(d.start_date, d.end_date, props.groupStartDate, props.groupEndDate))
  },
})

/** Live preview: publish the bar's proposed dates while dragging/resizing.
 *  flush:'sync' — cell colors are recalculated immediately on each move. */
watch(
  dragSpan,
  (sp) => {
    if (!sp) {
      emit('dragend')
      return
    }
    const d = spanToDates(props.timeline.origin, props.timeline.unit, sp.startCell, sp.endCell)
    const payload = clampSpanDates(d.start_date, d.end_date, props.groupStartDate, props.groupEndDate)
    if (isDragging.value) emit('dragmove', payload)
    else emit('dragstart', payload)
  },
  { flush: 'sync' },
)

// === Keyboard move (accessibility) ===
// A draggable bar is focusable and exposes the same date shift as the pointer
// drag: ←/→ move by one unit (a day, or a decade cell), Shift+←/→ by five such
// units, Alt+←/→ always by one DAY (in decade mode a single cell step would
// move ten days, so the fine step is computed in days). The shift is applied to
// the cell span and committed through the very same `change` emit the drag uses
// (see `onCommit` above), so the result equals a mouse drag by the same number
// of cells. The resize handles stay pointer-only: they keep `aria-hidden`.

/** Cells in one keyboard step: the timeline unit itself, overridable by prop */
const moveStepCells = computed(() => {
  if (props.moveStepCells != null && props.moveStepCells > 0) return props.moveStepCells
  return props.timeline.unit === 'decade' ? 3 : 1
})

/** Screen-reader value: the same range as the tooltip, in words */
const ariaValueText = computed(() => span.value ? formatDateRange(props.startDate, props.endDate) : '')

/** Accessible name of the bar (role="slider"): range + title, overridable */
const ariaLabel = computed(() => {
  if (props.ariaLabel) return props.ariaLabel
  const name = props.title ? `«${props.title}»` : t('planner.bar.task')
  return t('planner.bar.taskNamed', { title: name, range: dateRange.value })
})

/** aria-value* bounds: the parent (process/project) span when it is known */
const ariaMin = computed(() =>
  bounds.value ? Math.min(bounds.value.startCell, bounds.value.endCell - 1) : undefined,
)
const ariaMax = computed(() => bounds.value?.endCell)
const ariaNow = computed(() => span.value?.startCell)

/** Keyboard move: Δ cells (negative — earlier), committed like a drag release */
function moveBy(deltaCells: number) {
  const s = span.value
  if (!s) return
  const shifted = { startCell: s.startCell + deltaCells, endCell: s.endCell + deltaCells }
  const dates = spanToDates(props.timeline.origin, props.timeline.unit, shifted.startCell, shifted.endCell)
  const payload = clampSpanDates(dates.start_date, dates.end_date, props.groupStartDate, props.groupEndDate)
  // Live loading preview, exactly like a pointer drag started/continued
  emit('keyboardmove', payload)
  emit('change', payload)
}

/** Keyboard fine-step: shifts the whole span by a single calendar day (any unit) */
function moveByDays(deltaDays: number) {
  const s = span.value
  if (!s) return
  const from = toDate(props.startDate)
  const to = toDate(props.endDate)
  const payload = clampSpanDates(
    fmtDate(new Date(from.getFullYear(), from.getMonth(), from.getDate() + deltaDays)),
    fmtDate(new Date(to.getFullYear(), to.getMonth(), to.getDate() + deltaDays)),
    props.groupStartDate,
    props.groupEndDate,
  )
  emit('keyboardmove', payload)
  emit('change', payload)
}

function onKeydown(e: KeyboardEvent) {
  if (!props.draggable || e.ctrlKey || e.metaKey) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  if (e.altKey) {
    // Fine-grained step: exactly one day in decade mode too.
    moveByDays(e.key === 'ArrowLeft' ? -1 : 1)
    return
  }
  const base = moveStepCells.value
  const step = e.shiftKey ? base * 5 : base
  moveBy(e.key === 'ArrowLeft' ? -step : step)
}

const barStyle = computed<Record<string, string | number> | null>(() => {
  const t = props.timeline
  const s = span.value
  if (!s || !visible.value) return null
  return {
    left: t.cellLeft(s.startCell) + 'px',
    width: (s.endCell - s.startCell) * t.cellPx + 'px',
    background: props.color,
    opacity: props.opacity,
    height: props.height + 'px',
    top: props.top + 'px',
    minWidth: props.minWidth + 'px',
    padding: props.padding,
  }
})

const cursorStyle = computed<Record<string, string>>(() => {
  if (cursor.value) return { cursor: cursor.value }
  // Resting state: the bar "can be clicked" (navigation/editor) — a pointer,
  // not a drag hand; the drag hand appears only while dragging.
  if (props.draggable) return { cursor: 'pointer' }
  return { cursor: 'default' }
})

/** Bar date range "dd.mm.yyyy — dd.mm.yyyy" (for tooltip and slots) */
const dateRange = computed(() => formatDateRange(props.startDate, props.endDate))

function onHandlePointerDown(e: PointerEvent, mode: 'resizeStart' | 'resizeEnd') {
  if (props.draggable) startDrag(e, mode)
}

/** Double click on the bar does nothing; cancel the deferred single click (navigation) */
function onDblClick() {
  if (clickTimer) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
}

function onContextMenu(e: MouseEvent) {
  emit('contextmenu', { clientX: e.clientX, clientY: e.clientY })
}
</script>

<template>
  <div
    v-if="barStyle"
    class="gantt-bar"
    :class="{ 'gb-draggable': draggable, 'gb-shadow': shadow, 'is-dragging': isDragging }"
    :style="[barStyle, previewStyle, cursorStyle]"
    :title="hasTooltip ? undefined : title"
    :tabindex="draggable ? 0 : undefined"
    :role="draggable ? 'slider' : undefined"
    :aria-label="draggable ? ariaLabel : undefined"
    :aria-valuemin="draggable ? ariaMin : undefined"
    :aria-valuemax="draggable ? ariaMax : undefined"
    :aria-valuenow="draggable ? ariaNow : undefined"
    :aria-valuetext="draggable ? ariaValueText : undefined"
    @pointerdown="onBodyPointerDown"
    @pointerup="onPointerUp"
    @dblclick="onDblClick"
    @keydown="onKeydown"
    @contextmenu.prevent.stop="onContextMenu"
  >
    <TooltipCell v-if="hasTooltip" :text="tooltip ?? ''" :multiline="true" @open="emit('tooltip-open')">
      <slot>
        <span class="lb-title">{{ title }}</span>
        <span v-if="projectCode" class="lb-code">{{ projectCode }}</span>
        <span v-if="ownerLabel" class="lb-owner" :title="t('planner.bar.owner', { owner: ownerName })">{{ ownerLabel }}</span>
        <span v-if="responsibleLabel" class="lb-responsible" :title="t('planner.bar.responsible', { name: responsibleName })">{{ responsibleLabel }}</span>
      </slot>
      <template #popup>
        <slot name="tooltip" :dateRange="dateRange">
          <div class="lb-tt">
            <div class="lb-tt-title">{{ title }}</div>
            <div class="lb-tt-row">{{ dateRange }}</div>
          </div>
        </slot>
      </template>
    </TooltipCell>
    <slot v-else>
      <span class="lb-title">{{ title }}</span>
      <span v-if="projectCode" class="lb-code">{{ projectCode }}</span>
      <span v-if="ownerLabel" class="lb-owner" :title="t('planner.bar.owner', { owner: ownerName })">{{ ownerLabel }}</span>
      <span v-if="responsibleLabel" class="lb-responsible" :title="t('planner.bar.responsible', { name: responsibleName })">{{ responsibleLabel }}</span>
    </slot>
    <template v-if="draggable">
      <span
        class="gb-handle gb-handle-l"
        style="cursor: ew-resize"
        aria-hidden="true"
        @pointerdown.stop="onHandlePointerDown($event, 'resizeStart')"
      />
      <span
        class="gb-handle gb-handle-r"
        style="cursor: ew-resize"
        aria-hidden="true"
        @pointerdown.stop="onHandlePointerDown($event, 'resizeEnd')"
      />
    </template>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.gantt-bar {
  position: absolute;
  border-radius: 5px;
  display: flex;
  align-items: center;
  overflow: hidden;
  box-sizing: border-box;
  transition: opacity var(--ui-duration);
}
.gantt-bar :deep(.tt-trigger) {
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  cursor: inherit;
}
.gantt-bar:hover {
  opacity: 0.95 !important;
}
/* Keyboard focus: the bar is a focusable slider, the outline must stay visible
   above the neighbouring rows (light outline over the light bar) */
.gantt-bar:focus-visible {
  outline: 2px solid var(--ui-focus);
  outline-offset: 1px;
  z-index: var(--z-grid);
}
.gb-draggable {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.is-dragging {
  opacity: 0.95 !important;
}
.gb-shadow {
  box-shadow: var(--ui-shadow-sm);
}
.gb-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: var(--z-bar);
  touch-action: none;
}
.gb-handle-l {
  left: 0;
  border-radius: 5px 0 0 5px;
}
.gb-handle-r {
  right: 0;
  border-radius: 0 5px 5px 0;
}
.gb-handle:hover {
  background: rgba(255, 255, 255, 0.35);
}
.lb-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 700;
  color: var(--ui-accent-on);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
  pointer-events: none;
}
.lb-owner,
.lb-responsible {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 600;
  line-height: 1.6;
  color: var(--ui-accent-on);
  border-radius: 10px;
  padding: 0 7px;
  margin-left: 6px;
  white-space: nowrap;
  pointer-events: none;
}
.lb-owner {
  background: rgba(13, 102, 134, 0.85);
}
.lb-responsible {
  background: rgba(99, 76, 170, 0.85);
}
.lb-code {
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.15);
  border-radius: 3px;
  padding: 0 5px;
  margin-left: 6px;
  white-space: nowrap;
  pointer-events: none;
}
.lb-tt {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1.5;
}
.lb-tt-title {
  font-weight: 700;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  margin-bottom: 2px;
}
.lb-tt-row {
  color: var(--ui-text-2);
  white-space: nowrap;
}
</style>
