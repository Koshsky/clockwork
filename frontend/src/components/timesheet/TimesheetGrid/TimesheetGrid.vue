<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { fmtDate } from '../../planner/calendar'
import { fmtDate as fmtLocalDate, fmtDateRange } from '@/i18n/date'
import { LABEL_WIDTH } from '../../planner/layout'
import { stateBackground } from '../stateColors'
import TimesheetCell from '../TimesheetCell/TimesheetCell.vue'
import { TooltipCell, InfoTooltip } from '@/components/common'
import { t as $t } from '@/i18n'
import type { ClearPayload, TimesheetGridProps } from './types'

const props = withDefaults(defineProps<TimesheetGridProps>(), {
  error: null,
  busy: false,
  canAssign: () => () => true,
  canClear: () => () => true,
})

const emit = defineEmits<{
  assign: [payload: { employeeId: number; stateId: number; startDate: string; endDate: string }]
  clear: [payload: ClearPayload]
  /** The visible date range changed (to load more of the states window) */
  range: [payload: { startDate: string; endDate: string }]
}>()

/** Employee row and name-layer height (px): two lines — full name + position */
const ROW_H = 32

/**
 * Delay before opening the assignment panel after mouse release: distinguishes a single
 * click (open the menu) from a double-click (zoom reset). If a second click arrives within
 * this interval, the panel is not opened; the reset is handled by the dblclick event.
 */
const OPEN_DELAY_MS = 200
let openTimer: ReturnType<typeof setTimeout> | null = null

/** Active range selection (drag) */
const selection = ref<{ employeeId: number; startIdx: number; endIdx: number } | null>(null)

/** Live tooltip position — follows the cursor while selecting (assignment feedback) */
const dragTip = ref<{ x: number; y: number } | null>(null)

/** Whether a range drag is in progress (left mouse button held) */
const dragging = ref(false)

/** Floating panel for assigning a state */
const panel = ref<{
  x: number
  y: number
  employeeId: number
  startDate: string
  endDate: string
} | null>(null)

/** Reference to the panel for measuring its actual size */
const panelEl = ref<HTMLElement | null>(null)

/** Panel offset from window edges (px) */
const PANEL_MARGIN = 8

/**
 * Checks whether the panel fits in the browser window; if not,
 * shifts it so that it stays entirely within the visible area.
 */
function clampPanel() {
  const el = panelEl.value
  const p = panel.value
  if (!el || !p) return
  const rect = el.getBoundingClientRect()
  let { x, y } = p
  if (x + rect.width > window.innerWidth - PANEL_MARGIN) {
    x = Math.max(PANEL_MARGIN, window.innerWidth - PANEL_MARGIN - rect.width)
  }
  if (y + rect.height > window.innerHeight - PANEL_MARGIN) {
    y = Math.max(PANEL_MARGIN, window.innerHeight - PANEL_MARGIN - rect.height)
  }
  if (x !== p.x || y !== p.y) panel.value = { ...p, x, y }
}

/** After the panel opens, measure it and adjust its position to fit the window size */
watch(panel, (p) => {
  if (p) {
    nextTick(clampPanel)
    window.addEventListener('resize', clampPanel)
  } else {
    window.removeEventListener('resize', clampPanel)
  }
})

function isoFor(i: number): string {
  return fmtDate(props.t.cellStart(i))
}

function isWeekend(i: number): boolean {
  const d = props.t.cellStart(i).getDay()
  return d === 0 || d === 6
}

function employeeName(id: number): string {
  return props.employees.find((e) => e.id === id)?.name ?? `#${id}`
}

function fmtDM(iso?: string): string {
  return iso ? fmtLocalDate(iso) : ''
}

/** Full date range of the active selection (for the live tooltip) */
const rangeLabel = computed(() => {
  const s = selection.value
  if (!s || Number.isNaN(s.endIdx)) return ''
  const lo = Math.min(s.startIdx, s.endIdx)
  const hi = Math.max(s.startIdx, s.endIdx)
  return fmtDateRange(fmtDate(props.t.cellStart(lo)), fmtDate(props.t.cellEnd(hi)))
})

/** Date range of the active selection a cell belongs to, for its hover tooltip */
function selectionRangeFor(employeeId: number, idx: number): { start: string; end: string } | null {
  const s = selection.value
  if (!s || s.employeeId !== employeeId) return null
  const lo = Math.min(s.startIdx, s.endIdx)
  const hi = Math.max(s.startIdx, s.endIdx)
  if (idx < lo || idx > hi) return null
  return {
    start: fmtDate(props.t.cellStart(lo)),
    end: fmtDate(props.t.cellEnd(hi)),
  }
}

function isSelected(employeeId: number, idx: number): boolean {
  const s = selection.value
  if (!s || s.employeeId !== employeeId) return false
  const lo = Math.min(s.startIdx, s.endIdx)
  const hi = Math.max(s.startIdx, s.endIdx)
  return idx >= lo && idx <= hi
}

/** Clamp the live tooltip position (cursor + offset) to the window boundaries */
function dragTipStyle(): Record<string, string> {
  const p = dragTip.value
  if (!p) return {}
  return {
    left: Math.max(0, Math.min(p.x + 10, window.innerWidth - 200)) + 'px',
    top: Math.max(0, Math.min(p.y + 10, window.innerHeight - 40)) + 'px',
  }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || props.busy) return
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.ts-cell')
  if (!cell) return
  const empId = Number(cell.dataset.employeeId)
  const idx = Number(cell.dataset.cellIndex)
  if (empId == null || Number.isNaN(idx)) return
  e.preventDefault()
  selection.value = { employeeId: empId, startIdx: idx, endIdx: idx }
  dragTip.value = { x: e.clientX, y: e.clientY }
  dragging.value = true
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
}

function onPointerMove(e: PointerEvent) {
  if (!selection.value) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const cell = el?.closest<HTMLElement>('.ts-cell')
  if (!cell) return
  const empId = Number(cell.dataset.employeeId)
  // Keep the selection within the starting employee's row
  if (empId !== selection.value.employeeId) return
  const idx = Number(cell.dataset.cellIndex)
  if (!Number.isNaN(idx)) {
    selection.value.endIdx = idx
    dragTip.value = { x: e.clientX, y: e.clientY }
  }
}

function onPointerUp(e: PointerEvent) {
  const s = selection.value
  selection.value = null
  dragging.value = false
  dragTip.value = null
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  // The drag may have left a browser selection anchor — clear it so a click outside the panel
  // does not "stretch" text between clicks
  window.getSelection()?.removeAllRanges()
  if (!s || Number.isNaN(s.endIdx)) return
  // Rows the current user cannot edit (worker.update) are not selectable
  if (!props.canAssign(s.employeeId)) return
  const lo = Math.min(s.startIdx, s.endIdx)
  const hi = Math.max(s.startIdx, s.endIdx)
  const payload = {
    x: Math.min(e.clientX, window.innerWidth - 220),
    y: Math.min(e.clientY, window.innerHeight - 140),
    employeeId: s.employeeId,
    startDate: fmtDate(props.t.cellStart(lo)),
    endDate: fmtDate(props.t.cellEnd(hi)),
  }
  // Second click of a double-click — do not open the panel: the zoom reset is handled by dblclick
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
    return
  }
  // Show the selection immediately, the panel after a delay (to distinguish a double-click)
  selection.value = { employeeId: s.employeeId, startIdx: lo, endIdx: hi }
  openTimer = setTimeout(() => {
    openTimer = null
    panel.value = payload
  }, OPEN_DELAY_MS)
}

function onAssign(stateId: number) {
  if (!panel.value) return
  emit('assign', {
    employeeId: panel.value.employeeId,
    stateId,
    startDate: panel.value.startDate,
    endDate: panel.value.endDate,
  })
  closePanel()
}

function onClear() {
  if (!panel.value) return
  emit('clear', {
    employeeId: panel.value.employeeId,
    startDate: panel.value.startDate,
    endDate: panel.value.endDate,
  })
  closePanel()
}

function closePanel() {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  panel.value = null
  selection.value = null
  dragTip.value = null
  dragging.value = false
  // Remove the browser selection left after a drag/click outside the panel
  window.getSelection()?.removeAllRanges()
}

/** Click outside the panel (overlay): close it and prevent creating/extending a text selection */
function onOverlayPointerDown(e: PointerEvent) {
  e.preventDefault()
  closePanel()
}

/**
 * Double-click on the timesheet resets the zoom to the default (handled by the infinite
 * scale). Here we cancel the delayed panel opening and clear the selection so that
 * a single click (opening the menu) does not fire on a double one.
 */
function onDblClick() {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  panel.value = null
  selection.value = null
  dragTip.value = null
  dragging.value = false
}

onBeforeUnmount(() => {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('resize', clampPanel)
  document.body.style.userSelect = ''
  dragTip.value = null
  dragging.value = false
})

/** The visible date range — signal to load more states (on scroll/zoom) */
watch(
  () => [props.t.windowStart, props.t.viewportCells, props.t.cellPx] as const,
  () => {
    const idx = props.t.visibleIndices
    if (!idx.length) return
    emit('range', {
      startDate: fmtDate(props.t.cellStart(idx[0])),
      endDate: fmtDate(props.t.cellEnd(idx[idx.length - 1])),
    })
  },
  { immediate: true },
)

const labelsH = computed(() => props.employees.length * ROW_H)
</script>

<template>
  <div class="ts" @pointerdown="onPointerDown" @dblclick="onDblClick">
    <!-- Employee names layer: rows stick to the left and scroll vertically with the rows -->
    <div
      class="ts-labels"
      :style="{ width: LABEL_WIDTH + 'px', marginBottom: '-' + labelsH + 'px' }"
    >
      <TooltipCell
        v-for="emp in employees"
        :key="'tsl' + emp.id"
        class="ts-label"
        :style="{ height: ROW_H + 'px' }"
        :multiline="true"
      >
        <span class="ts-label-name">{{ emp.name }}</span>
        <span class="ts-label-pos">{{ emp.position }}</span>
        <template #popup>
          <InfoTooltip
            :title="emp.name"
            :lines="[emp.position].filter((x): x is string => Boolean(x))"
          />
        </template>
      </TooltipCell>
    </div>

    <!-- Cell grid: one row per employee, cells by visible days -->
    <div class="ts-rows">
      <div
        v-for="emp in employees"
        :key="'tsr' + emp.id"
        class="ts-row"
        :style="{ height: ROW_H + 'px' }"
      >
        <div
          v-for="i in t.visibleIndices"
          :key="'tsc' + i"
          class="ts-cell"
          :style="{ left: t.cellLeft(i) + 'px', width: t.cellPx + 'px' }"
          :data-employee-id="emp.id"
          :data-cell-index="i"
        >
          <TimesheetCell
            :state="stateForDay(emp.id ?? 0, isoFor(i)) ?? null"
            :is-weekend="isWeekend(i)"
            :selected="isSelected(emp.id ?? 0, i)"
            :selection-range="selectionRangeFor(emp.id ?? 0, i)"
            :tooltip-disabled="dragging"
            :show-text="t.cellPx >= 40"
            :color-map="props.colorMap"
          />
        </div>
      </div>
    </div>

    <p v-if="error" class="ts-error">{{ error }}</p>

    <!-- Live tooltip: date range of the fragment being selected (follows the cursor) -->
    <div
      v-if="dragTip && selection && !panel"
      class="ts-range-tip"
      :style="dragTipStyle()"
      aria-hidden="true"
    >
      {{ rangeLabel }}
    </div>

    <!-- Floating panel for assigning a state to the selected range -->
    <Teleport to="body">
      <template v-if="panel">
        <div class="ts-overlay" @pointerdown="onOverlayPointerDown" />
        <div class="ts-panel" ref="panelEl" :style="{ left: panel.x + 'px', top: panel.y + 'px' }" role="dialog" :aria-label="$t('timesheet.panel.ariaLabel')">
          <div class="ts-panel-head">
            <span class="ts-panel-title">{{ employeeName(panel.employeeId) }}</span>
            <TooltipCell class="ts-panel-range" :multiline="true">
              <span>{{ fmtDM(panel.startDate) }}–{{ fmtDM(panel.endDate) }}</span>
              <template #popup>
                <InfoTooltip :lines="[fmtDateRange(panel.startDate, panel.endDate)]" />
              </template>
            </TooltipCell>
            <button type="button" class="ts-panel-close" :aria-label="$t('timesheet.panel.close')" @click="closePanel">×</button>
          </div>
          <div v-if="props.canAssign(panel.employeeId)" class="ts-panel-states">
            <button
              v-for="st in states"
              :key="'ts' + st.id"
              type="button"
              class="ts-state"
              :disabled="busy"
              @click="onAssign(st.id ?? 0)"
            >
              <span
                class="ts-state-swatch"
                :style="{ background: st.color ?? stateBackground(st.code, st.is_available, st.id) }"
              />
              {{ st.name }}
            </button>
          </div>
          <div class="ts-panel-actions">
            <button
              v-if="props.canClear(panel.employeeId)"
              type="button"
              class="ts-btn-clear"
              :disabled="busy"
              @click="onClear"
            >
              {{ $t('timesheet.panel.clear') }}
            </button>
          </div>
        </div>
      </template>
    </Teleport>
  </div>
</template>

<style scoped>
@import '../../../styles/tokens.css';

.ts {
  position: relative;
}
/* Side names panel: sticks to the left, above the content (cells/lines), the calendar header
   (--z-header) and the current-date line (--z-today), but below the corner (--z-corner). The column is LABEL_WIDTH wide, so
   it does not overlap the header (the header has a corner on its left), and the "today" line runs from x>=180. */
.ts-labels {
  position: sticky;
  left: 0;
  z-index: var(--z-side-panel);
  background: var(--ui-surface);
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}
.ts-label {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 0 8px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--ui-border);
  overflow: hidden;
  cursor: default;
}
.ts-label-name {
  font-weight: 700;
  color: var(--ui-text);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-label-pos {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-2);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-rows {
  min-height: 100%;
}
.ts-row {
  position: relative;
  box-sizing: border-box;
  border-bottom: 1px solid var(--ui-border);
}
.ts-cell {
  position: absolute;
  top: 0;
  bottom: 0;
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
}
.ts-error {
  margin: 10px 0 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
}

/* Live selection tooltip: same look as the regular popovers, but fixed at the cursor */
.ts-range-tip {
  position: fixed;
  background: var(--ui-surface);
  color: var(--ui-text);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1.45;
  padding: 6px 10px;
  border-radius: var(--ui-radius-sm);
  border: 1px solid var(--ui-border);
  box-shadow: var(--ui-shadow-md);
  white-space: nowrap;
  pointer-events: none;
  z-index: 900;
}

.ts-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: transparent;
  user-select: none;
  -webkit-user-select: none;
}
.ts-panel {
  position: fixed;
  z-index: 1001;
  width: 200px;
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-lg);
  border: 1px solid var(--ui-border);
  overflow: hidden;
}
.ts-panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: var(--ui-surface-2);
  border-bottom: 1px solid var(--ui-border);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
}
.ts-panel-title {
  font-weight: 700;
  color: var(--ui-accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-panel-range {
  color: var(--ui-text-2);
  flex: 1;
  text-align: right;
}
.ts-panel-close {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  line-height: 1;
  color: var(--ui-text-muted);
  cursor: pointer;
  padding: 0 2px;
}
.ts-panel-close:hover {
  color: var(--ui-text);
}
.ts-panel-states {
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}
.ts-state {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: var(--ui-surface-2);
  border-radius: var(--ui-radius-sm);
  padding: 8px 10px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  text-align: left;
  cursor: pointer;
  transition: background var(--ui-duration);
}
.ts-state:hover:not(:disabled) {
  background: var(--ui-surface-3);
}
.ts-state:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ts-state-swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1px solid var(--ui-border-strong);
  flex-shrink: 0;
}
.ts-panel-actions {
  padding: 0 8px 8px;
}
.ts-btn-clear {
  width: 100%;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  border-radius: var(--ui-radius-sm);
  padding: 8px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
  cursor: pointer;
}
.ts-btn-clear:hover:not(:disabled) {
  background: var(--ui-danger-soft);
}
.ts-btn-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
