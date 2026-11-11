<script setup lang="ts" generic="Row = unknown">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../../i18n'
import type { DataTableColumn, DataTableCellScope, DataTableProps, SortDir } from './types'

const props = withDefaults(defineProps<DataTableProps<Row>>(), {
  emptyText: '',
  expandable: false,
  resizable: false,
  defaultSort: null,
})

const emit = defineEmits<{
  /** Emitted when the sort state changes (key of the sorted column + direction). */
  'update:sort': [sort: { key: string; dir: SortDir } | null]
  /** Emitted on right-click of a data row (native event + the row). */
  'row-contextmenu': [event: MouseEvent, row: Row]
  /** Emitted on click of a data row (native event + the row). */
  'row-click': [event: MouseEvent, row: Row]
  /** Emitted when a column width changes (column key → pixel width). */
  'update:columnWidths': [widths: Record<string, number>]
}>()

defineSlots<{
  /** Toolbar actions (buttons/filters), shown on the right of the title. */
  actions?: () => unknown
  /** Custom cell rendering; default renders `row[column.key]` text. */
  cell?: (scope: DataTableCellScope<Row>) => unknown
  /** Per-column filter controls, rendered under the header row (slot per column). */
  filter?: (scope: { column: DataTableColumn }) => unknown
  /** Expanded detail row below a row (only with expandable, keyed by row index). */
  expanded?: (scope: { row: Row; index: number }) => unknown
}>()

// --- Column sorting (client-side, cycle: asc → desc → off) -----------------

const sortBy = ref<{ key: string; dir: SortDir } | null>(props.defaultSort)

/** Sort key value for a row: page-provided hook or the raw row field. */
function sortValueOf(row: Row, key: string): unknown {
  if (props.sortValue) return props.sortValue(row, key)
  return (row as Record<string, unknown>)[key]
}

function toggleSort(col: DataTableColumn) {
  if (col.sortable === false) return
  if (sortBy.value?.key === col.key) {
    sortBy.value = sortBy.value.dir === 1 ? { key: col.key, dir: -1 } : null
  } else {
    sortBy.value = { key: col.key, dir: 1 }
  }
  emit('update:sort', sortBy.value)
}

function sortActive(col: DataTableColumn, dir: SortDir): boolean {
  return sortBy.value?.key === col.key && sortBy.value.dir === dir
}

function ariaSort(col: DataTableColumn): 'ascending' | 'descending' | 'none' {
  if (sortBy.value?.key !== col.key) return 'none'
  return sortBy.value.dir === 1 ? 'ascending' : 'descending'
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a ?? '').localeCompare(String(b ?? ''), 'ru')
}

const visibleRows = computed(() => {
  const s = sortBy.value
  if (!s) return props.rows
  return [...props.rows].sort((a, b) => {
    return compareValues(sortValueOf(a, s.key), sortValueOf(b, s.key)) * s.dir
  })
})

// --- Column tracks ----------------------------------------------------------

/**
 * Fixed user widths (drag-resize, persisted by the parent) override the
 * column config; everything else stays content-sized. A trailing 1fr spacer
 * keeps every row's grid area (and the header/hover bands) full-width.
 */
const columnWidths = ref<Record<string, number>>({ ...(props.columnWidths ?? {}) })

watch(
  () => props.columnWidths,
  (value) => {
    if (value) columnWidths.value = { ...value }
  },
)

function setColumnWidth(key: string, widthPx: number) {
  columnWidths.value = { ...columnWidths.value, [key]: widthPx }
  emit('update:columnWidths', columnWidths.value)
}

function clearColumnWidth(key: string) {
  const next = { ...columnWidths.value }
  delete next[key]
  columnWidths.value = next
  emit('update:columnWidths', columnWidths.value)
}

const columnsCss = computed(() => {
  const tracks = props.columns.map((col) => {
    const fixed = columnWidths.value[col.key]
    return fixed ? `${fixed}px` : (col.width ?? 'fit-content(320px)')
  })
  return [...tracks, '1fr'].join(' ')
})

// --- Column resizing (drag on the header edge) ------------------------------

const MIN_COL_WIDTH = 60
const MAX_COL_WIDTH = 1200

let dragState: { key: string; startX: number; baseWidth: number } | null = null

function startResize(e: MouseEvent, col: DataTableColumn) {
  if (!props.resizable) return
  e.preventDefault()
  e.stopPropagation()
  const cell = (e.currentTarget as HTMLElement).closest('.dt-th-cell') as HTMLElement | null
  dragState = { key: col.key, startX: e.clientX, baseWidth: cell?.getBoundingClientRect().width ?? 0 }
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize, { once: true })
  document.body.classList.add('dt-resizing')
}

function onResizeMove(e: MouseEvent) {
  if (!dragState) return
  const width = Math.round(dragState.baseWidth + e.clientX - dragState.startX)
  setColumnWidth(dragState.key, Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width)))
}

function stopResize() {
  dragState = null
  document.removeEventListener('mousemove', onResizeMove)
  document.body.classList.remove('dt-resizing')
}

/** Double-click on the handle: back to the content-sized width. */
function resetResize(col: DataTableColumn) {
  clearColumnWidth(col.key)
}

// --- Middle-mouse drag panning (MMB press + drag moves the table) -----------
// Navigation by dragging with the middle mouse button: pressing MMB anywhere
// in the table and dragging scrolls the container in both axes. LMB keeps its
// own interactions (sort, resize, row click/expand) untouched.

/** Interactive elements inside the table from which MMB panning must not start */
const PAN_START_IGNORE = 'a, button, input, select, textarea, .dt-resizer, [contenteditable]'
/** Movement needed to turn an MMB press into a drag (a plain click still works) */
const PAN_THRESHOLD_PX = 4

const scrollEl = ref<HTMLElement | null>(null)
/** MMB press origin (before the drag threshold is crossed) */
let panStart: { x: number; y: number; pointerId: number } | null = null
/** True once the MMB press became a real drag (past the threshold) */
let panMoved = false
let lastX = 0
let lastY = 0
/** Swallow the click that directly follows a committed MMB drag (it would otherwise toggle expand / fire row-click) */
let suppressClick = false

/**
 * Blocks the browser's native middle-click autoscroll: cancelling the
 * pointerdown alone is not enough in all browsers, the autoscroll is a
 * default action of the derived mousedown.
 */
function onScrollMousedown(e: MouseEvent) {
  if (e.button === 1) e.preventDefault()
}

function onScrollPointerDown(e: PointerEvent) {
  // A fresh press is by definition not a lingering drag-release click.
  suppressClick = false
  if (e.button !== 1 || e.pointerType !== 'mouse' || panStart) return
  const el = scrollEl.value
  if (!el) return
  if ((e.target as HTMLElement).closest(PAN_START_IGNORE)) return
  panStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
  lastX = e.clientX
  lastY = e.clientY
  // Global "grabbing fist" (body.pan-grabbing) while MMB is held — applies to
  // the whole page, not only the table area.
  document.body.classList.add('pan-grabbing')
  window.addEventListener('pointermove', onScrollPointerMove)
  window.addEventListener('pointerup', onScrollPointerUp)
  window.addEventListener('pointercancel', onScrollPointerCancel)
}

function onScrollPointerMove(e: PointerEvent) {
  if (!panStart) return
  const el = scrollEl.value
  if (!el) return
  if (!panMoved) {
    if (
      Math.abs(e.clientX - panStart.x) < PAN_THRESHOLD_PX &&
      Math.abs(e.clientY - panStart.y) < PAN_THRESHOLD_PX
    ) {
      return
    }
    // Threshold crossed — this is a real drag, not a plain middle click.
    panMoved = true
    suppressClick = true
    e.preventDefault()
    el.classList.add('dt-panning')
    document.body.style.userSelect = 'none'
    // Capture the pointer so the drag survives leaving the browser window.
    // Synthetic pointer events (tests) have no active pointer — capture is optional.
    try {
      el.setPointerCapture(panStart.pointerId)
    } catch {
      /* no active pointer — nothing to capture */
    }
  }
  // Incremental deltas (scrollLeft/scrollTop clamp natively)
  el.scrollLeft -= e.clientX - lastX
  el.scrollTop -= e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
}

function endPan(e?: PointerEvent) {
  const el = scrollEl.value
  // The browser coalesces fast pointermove events — flush the remaining delta
  // from the release event coords.
  if (el && e && panMoved) {
    el.scrollLeft -= e.clientX - lastX
    el.scrollTop -= e.clientY - lastY
  }
  panStart = null
  panMoved = false
  el?.classList.remove('dt-panning')
  document.body.classList.remove('pan-grabbing')
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onScrollPointerMove)
  window.removeEventListener('pointerup', onScrollPointerUp)
  window.removeEventListener('pointercancel', onScrollPointerCancel)
}

function onScrollPointerUp(e: PointerEvent) {
  endPan(e)
}

function onScrollPointerCancel() {
  // No release click follows a cancel — drop the suppression flag so it
  // cannot eat a later unrelated click.
  suppressClick = false
  endPan()
}

/** Swallow the click that directly follows a real MMB drag. */
function onPanClickCapture(e: MouseEvent) {
  if (!suppressClick) return
  suppressClick = false
  e.preventDefault()
  e.stopImmediatePropagation()
}

onBeforeUnmount(endPan)

/** Default cell text: '—' for empty values. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

// --- Expandable rows --------------------------------------------------------

const expandedIndex = ref<number | null>(null)

function onRowClick(event: MouseEvent, row: Row, index: number) {
  if (props.expandable) {
    expandedIndex.value = expandedIndex.value === index ? null : index
  }
  emit('row-click', event, row)
}
</script>

<template>
  <!-- Card frame: the toolbar stays put while only the table area below it
       scrolls horizontally (toolbar must not travel with the columns). -->
  <div class="dt-card">
    <!-- Row 1: toolbar — title + actions (room for future buttons) -->
    <div class="dt-tbar">
      <h2 v-if="title" class="dt-tbar-title">{{ title }}</h2>
      <div class="dt-tbar-actions">
        <slot name="actions" />
      </div>
    </div>

    <!-- Scroll wrapper: when the columns are wider than the card it scrolls
         horizontally instead of letting the grid squeeze the tracks
         (squeezing with overflow-wrap: anywhere would collapse tracks to
         one-character width — "vertical text"). -->
    <div
      ref="scrollEl"
      class="dt-scroll"
      @mousedown="onScrollMousedown"
      @pointerdown="onScrollPointerDown"
      @click.capture="onPanClickCapture"
    >
      <div class="dt-table" :style="{ gridTemplateColumns: columnsCss }">
        <!-- Row 2: column headers — one row. The optional per-column filter
             control sits inside its own header cell, right under the label. -->
        <div class="dt-tr dt-th">
          <template v-for="col in columns" :key="col.key">
            <div class="dt-th-cell">
              <button
                v-if="col.sortable !== false"
                type="button"
                class="dt-th-label"
                :aria-sort="ariaSort(col)"
                @click="toggleSort(col)"
              >
                <span>{{ col.label }}</span>
                <span class="dt-sort" aria-hidden="true">
                  <i :class="{ on: sortActive(col, 1) }">▲</i><i :class="{ on: sortActive(col, -1) }">▼</i>
                </span>
              </button>
              <div v-else class="dt-th-label">{{ col.label }}</div>
              <div v-if="$slots.filter" class="dt-th-filter">
                <slot name="filter" :column="col"></slot>
              </div>
              <span
                v-if="resizable"
                class="dt-resizer"
                :title="t('ui.dataTable.resizeColumn')"
                @mousedown.prevent.stop="startResize($event, col)"
                @dblclick.prevent.stop="resetResize(col)"
              ></span>
            </div>
          </template>
        </div>

        <!-- Data rows -->
        <template v-for="(row, i) in visibleRows" :key="i">
          <div
            class="dt-tr"
            :class="{ 'dt-tr--open': expandable && expandedIndex === i }"
            @contextmenu.prevent.stop="emit('row-contextmenu', $event, row)"
            @click="onRowClick($event, row, i)"
          >
            <div v-for="col in columns" :key="col.key" class="dt-cell">
              <slot name="cell" :row="row" :column="col">{{ formatValue((row as Record<string, unknown>)[col.key]) }}</slot>
            </div>
          </div>

          <!-- Expanded detail row below the open row -->
          <div v-if="$slots.expanded && expandable && expandedIndex === i" class="dt-tr dt-detail">
            <slot name="expanded" :row="row" :index="i" />
          </div>
        </template>

        <p v-if="!visibleRows.length" class="dt-empty">{{ emptyText || t('common.noData') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import '../../../styles/tokens.css';

/* Card frame: rounded corners + shadow; the toolbar is a fixed top band,
   only the .dt-scroll area below it scrolls horizontally. */
.dt-card {
  width: 100%;
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-sm);
  overflow: hidden;
}

/* Toolbar — row 1: title + actions. Lives outside the scroll area, so it
   never travels with the columns during horizontal scrolling. */
.dt-tbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--ui-border);
}
.dt-tbar-title {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  font-weight: 700;
  color: var(--ui-text);
}
.dt-tbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Scroll wrapper: when the columns are wider than the card, the grid is
   allowed to grow (width: max-content) and this area scrolls — tracks never
   squeeze below their caps. The table moves by middle-mouse drag; the resting
   state keeps the plain arrow cursor, the drag hand appears only while
   dragging. */
.dt-scroll {
  overflow-x: auto;
}
/* While an MMB drag is moving the table: grabbing cursor, no text selection */
.dt-scroll.dt-panning {
  cursor: grabbing;
}
.dt-scroll.dt-panning * {
  user-select: none;
  -webkit-user-select: none;
}
/* min-width: 100% keeps the table full-width when there are few columns
   (header/hover bands still span edge-to-edge via the 1fr spacer). */
.dt-table {
  display: grid;
  align-items: center;
  width: max-content;
  min-width: 100%;
}

/* Rows are full-width grid items inheriting the container's column tracks
   (subgrid): header band, separators and hover highlight span the whole
   card instead of stopping at the last data column. */
.dt-tr {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  border-bottom: 1px solid var(--ui-border);
}
.dt-tr:last-child {
  border-bottom: none;
}
.dt-cell,
.dt-th-cell {
  /* Header cell wrapper: label on top, the per-column filter right under it
     (tight), the resize handle on the right edge. Columns without a filter
     keep the label vertically centered. */
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 6px 20px 7px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
}
.dt-th-cell:has(.dt-th-filter:not(:empty)) {
  justify-content: flex-start;
}
.dt-tr:hover {
  background: var(--ui-surface-2);
}

/* Column headers — row 2: solid full-width band (one row, filters inside). */
.dt-th {
  background: var(--ui-surface-2);
}
.dt-th-label {
  border: none;
  /* Buttons get a UA buttonface background by default — make them
     transparent so header cells match the solid .dt-th band. */
  background: transparent;
  font: inherit;
  font-weight: 600;
  color: var(--ui-text-muted);
  text-align: left;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  cursor: pointer;
}
button.dt-th-label:hover {
  color: var(--ui-text);
}
.dt-th-filter {
  width: 100%;
  min-width: 0;
}

/* Filter controls inside the header cells: underline style — no box, no
   background, only a bottom rule; the rule turns accent on focus. Applies
   to any input/select placed into the #filter slot, regardless of the page. */
.dt-th-filter :deep(input),
.dt-th-filter :deep(select) {
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-bottom: 1px solid var(--ui-border-strong);
  border-radius: 0;
  background: transparent;
  color: var(--ui-text);
  font: inherit;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  padding: 3px 0 4px;
  outline: none;
}
.dt-th-filter :deep(input::placeholder) {
  color: var(--ui-text-muted);
}
.dt-th-filter :deep(select) {
  cursor: pointer;
}
.dt-th-filter :deep(input:focus),
.dt-th-filter :deep(select:focus) {
  border-bottom-color: var(--ui-accent);
}

/* Expanded/open row highlight + the detail row below it */
.dt-tr--open {
  background: var(--ui-surface-2);
}
.dt-detail {
  background: var(--ui-surface-2);
}
.dt-detail:last-child {
  border-bottom: none;
}

/* Sort indicators: ▲/▼ pair per header, active direction highlighted. */
.dt-sort {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  font-size: calc(var(--ui-font-scale, 1) * 8px);
  line-height: 1;
  color: var(--ui-text-faint);
  opacity: 0.6;
}
.dt-sort i {
  font-style: normal;
}
.dt-sort i.on {
  color: var(--ui-accent);
  opacity: 1;
}

/* Column resize handle on the right edge of every header cell: an 8px hit
   zone centered on the column border, with a visible divider line. */
.dt-th-cell {
  position: relative;
}
.dt-resizer {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 2;
}
/* The visible vertical line on the column border — dark enough to be seen
   on the header band (a border-strong color would be invisible against it). */
.dt-resizer::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 25%;
  bottom: 25%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--ui-text-faint);
}
.dt-resizer:hover::before {
  top: 0;
  bottom: 0;
  background: var(--ui-accent);
}
/* The last column has no neighbor — no divider/crosshair there. */
.dt-th > :last-child .dt-resizer {
  display: none;
}
/* Global resize cursor while a drag is in progress */
:global(body.dt-resizing),
:global(body.dt-resizing *) {
  cursor: col-resize !important;
  user-select: none;
}

/* Empty state spans the whole grid */
.dt-empty {
  grid-column: 1 / -1;
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
</style>