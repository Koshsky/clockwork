<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
import type { PlanningUnit } from '../calendar'
import { fmtDate, toDate } from '../calendar'
import { useInfiniteTimeline } from '../../../composables/useInfiniteTimeline'
import {
  INTERACTIVE_SELECTOR,
  TimelineScrollKey,
  TimelineSyncKey,
  type TimelineCtx,
} from '../../../composables/timeline-context'
import { useTimelinePan } from '../../../composables/useTimelinePan'
import { LABEL_WIDTH } from '../layout'
import TodayLine from '../TodayLine/TodayLine.vue'
import ScaleBadge from '../ScaleBadge/ScaleBadge.vue'

const props = defineProps<{
  /** Anchor date: cell with index 0 (initial timeline position) */
  origin: Date | string
  /** Cell unit: day or decade */
  unit: PlanningUnit
  /** Stable table id: scale and scroll persist across tab switches */
  id?: string
  /** On open/change, scroll the timeline so this date is at the left edge */
  focusDate?: string | null
  /** On open/change, scroll the container vertically to the group with this id */
  focusGroupId?: string | number | null
}>()

const emit = defineEmits<{
  /** Right-click on empty timeline space (not bars/labels): date, row and group under the cursor */
  ctxmenu: [payload: {
    clientX: number
    clientY: number
    date: string | null
    rowIndex?: number
    groupId?: string
  }]
  /** Right-click on the table header (calendar header / corner): scale switching */
  'header-ctxmenu': [payload: { clientX: number; clientY: number }]
  /**
   * Current visible timeline window (the "as on screen" period) + the effective
   * cell width accounting for zoom + the zoom scale (Ctrl+wheel). Debounced ~150 ms; emitted
   * on scroll/zoom/scale change and after mounting. Consumer — PDF export.
   */
  'visible-range': [payload: { from: string; to: string; cellWidthPx: number; scale: number }]
}>()

const scrollEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)
const unit = computed(() => props.unit)

/** Anchor date; today when origin is empty */
const originDate = props.origin ? toDate(props.origin) : new Date()

const tl = useInfiniteTimeline(originDate, unit, scrollEl, contentEl, props.id)

/**
 * Visible height in LOCAL px of the zoomed content. The grid is scaled by a CSS
 * `zoom` (Ctrl+wheel) on .tg-content, which multiplies every length inside it, so
 * covering the visible area takes viewportHeight / scale. Percentage and viewport
 * units cannot do that job: inside a zoomed element browsers disagree on whether
 * they compensate the factor (Firefox does not — at 50% zoom a `min-height: 100%`
 * box, and with it the "today" line and the grid that derive their height from
 * that box, end at half the visible height), while `100dvh` is never compensated
 * anywhere. Measured px divided by the scale works in every engine.
 */
const fitHeight = computed(() =>
  Math.round(tl.viewportHeight.value / (tl.tableScale.value || 1)),
)

provide(TimelineScrollKey, scrollEl)
provide(TimelineSyncKey, tl.sync)

onMounted(async () => {
  tl.mount()
  pan.enable()
  // Anchor (navigation from another tab): scroll after mount has
  // restored the saved position, so the anchor overrides it.
  if (props.focusDate || props.focusGroupId != null) {
    await nextTick()
    applyFocus()
  }
  emitVisibleRange()
})

/** Visible timeline window for consumers (print): first/last visible date + cell width */
function emitVisibleRange() {
  const start = tl.windowStart.value
  const count = tl.viewportCells.value
  if (count <= 0) return
  const from = fmtDate(tl.cellStart(start))
  const to = fmtDate(tl.cellEnd(start + count - 1))
  const cellWidthPx = Math.round(tl.cellPx.value * tl.tableScale.value * 100) / 100
  emit('visible-range', { from, to, cellWidthPx, scale: tl.tableScale.value })
}

let rangeTimer: ReturnType<typeof setTimeout> | null = null
function scheduleVisibleRange() {
  if (rangeTimer != null) clearTimeout(rangeTimer)
  rangeTimer = setTimeout(() => {
    rangeTimer = null
    emitVisibleRange()
  }, 150)
}

watch(
  [
    () => tl.windowStart.value,
    () => tl.viewportCells.value,
    () => tl.cellPx.value,
    () => tl.tableScale.value,
    () => unit.value,
  ],
  scheduleVisibleRange,
)

/** Anchor change without remounting (query change on the same page) */
watch(
  () => [props.focusDate, props.focusGroupId] as const,
  () => {
    if ((props.focusDate || props.focusGroupId != null) && scrollEl.value) {
      void nextTick(applyFocus)
    }
  },
)

/**
 * "Day"/"Decade" scale change: the center of the table stays the zoom anchor,
 * not the left edge. We capture the exact date at the window center using the old
 * scale (layout does not depend on unit), then scroll so that date is centered again.
 */
watch(
  () => props.unit,
  async (newUnit, oldUnit) => {
    const sc = scrollEl.value
    if (!sc || newUnit === oldUnit) return
    const centerDate = tl.dateAtViewportX(sc.clientWidth / 2, oldUnit)
    await nextTick()
    if (centerDate) tl.scrollToCenterDate(centerDate)
  },
)

/**
 * Scroll to the anchor: by date — the target cell at the left edge; by group —
 * the .gg-group with this id lands right below the sticky headers.
 */
function applyFocus() {
  if (props.focusDate) tl.scrollToDate(props.focusDate)
  if (props.focusGroupId != null) focusGroup(props.focusGroupId, 0, 0)
}

/**
 * Vertical scroll to a group: groups render via the slot after mounting, and their
 * position may change (lazy data/resource-row loading). Retry per frame until the
 * target lands under the sticky headers and "settles" for a couple of frames.
 */
function focusGroup(groupId: string | number, attempt: number, settled: number) {
  const sc = scrollEl.value
  if (!sc || attempt > 120) return
  const target = sc.querySelector<HTMLElement>(`.gg-group[data-group="${groupId}"]`)
  if (!target) {
    requestAnimationFrame(() => focusGroup(groupId, attempt + 1, 0))
    return
  }
  const delta = scrollGroupToTop(target)
  const nextSettled = Math.abs(delta) < 2 ? settled + 1 : 0
  if (nextSettled >= 3) return
  requestAnimationFrame(() => focusGroup(groupId, attempt + 1, nextSettled))
}

/** Vertical scroll: group top — under the sticky headers; returns the offset */
function scrollGroupToTop(target: HTMLElement): number {
  const sc = scrollEl.value
  if (!sc) return 0
  const scRect = sc.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const headH = sc.querySelector<HTMLElement>('.tg-head')?.offsetHeight ?? 0
  const rsH = sc.querySelector<HTMLElement>('.rs-block')?.offsetHeight ?? 0
  const delta = targetRect.top - scRect.top - headH - rsH
  sc.scrollTop += delta
  return delta
}

onBeforeUnmount(() => {
  if (rangeTimer != null) clearTimeout(rangeTimer)
  pan.disable()
  tl.unmount()
})

/**
 * MMB panning starts from ANY point of the table: empty space, bars,
 * milestones, reorder handles, sticky labels, the calendar header and the
 * resource ribbon. Content must not block moving the table left/right — the
 * LMB interactions of those elements (drag, resize, reorder) are guarded by
 * the components themselves and are unaffected.
 */
const PAN_IGNORE = ''

const pan = useTimelinePan(scrollEl, PAN_IGNORE)

/** Timeline context for slots: refs unwrapped; no Date (Proxy breaks) */
const ctx: TimelineCtx = reactive({
  origin: fmtDate(originDate),
  unit,
  cellPx: tl.cellPx,
  scale: tl.tableScale,
  scaleBump: tl.scaleBump,
  windowStart: tl.windowStart,
  viewportCells: tl.viewportCells,
  leftPad: tl.leftPad,
  contentWidth: tl.contentWidth,
  gridLeft: tl.gridLeft,
  visibleIndices: tl.visibleIndices,
  cellLeft: tl.cellLeft,
  cellStart: tl.cellStart,
  cellEnd: tl.cellEnd,
  dateAtPointer: tl.dateAtPointer,
  cellCoordAtPointer: tl.cellCoordAtPointer,
})

/** Right-click on empty timeline space (bars/labels/milestones intercept it themselves via .stop).
 *  Right-click on the table header — the scale switching menu (day/decade). */
function onContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.tg-head, .th-corner')) {
    emit('header-ctxmenu', { clientX: e.clientX, clientY: e.clientY })
    return
  }
  if (target.closest(INTERACTIVE_SELECTOR)) {
    return
  }
  const date = tl.dateAtPointer(scrollEl.value?.getBoundingClientRect() ?? null, e.clientX)
  const rowEl = target.closest<HTMLElement>('.gg-row')
  const groupEl = target.closest<HTMLElement>('.gg-group')
  // The milestone strip (.tg-task-group) sits next to .gg-group, not inside it, but it is the same
  // process group — resolve it through the nested .gg-group (append at the end, like empty space).
  const tgGroupEl = target.closest<HTMLElement>('.tg-task-group')
  const msGroupEl = !rowEl && !groupEl && tgGroupEl
    ? tgGroupEl.querySelector<HTMLElement>('.gg-group')
    : null
  const rowIndex = rowEl
    ? Number(rowEl.dataset.rowIndex)
    : groupEl
      ? Number(groupEl.dataset.rows ?? 0)
      : msGroupEl
        ? Number(msGroupEl.dataset.rows ?? 0)
        : undefined
  const groupId = (groupEl ?? msGroupEl)?.dataset.group ?? undefined
  emit('ctxmenu', { clientX: e.clientX, clientY: e.clientY, date, rowIndex, groupId })
}
</script>

<template>
  <div
    ref="scrollEl"
    class="tg-scroll"
    :style="{ '--label-width': LABEL_WIDTH + 'px' }"
    @contextmenu.prevent="onContextMenu"
  >
    <div
      ref="contentEl"
      class="tg-content"
      :style="{ width: ctx.contentWidth + 'px', '--tg-fit-height': fitHeight + 'px' }"
    >
      <!-- Opaque band of the side column: covers the whole visible height so the
           grid, the today line and the row backgrounds never show through it.
           Sits above the content (--z-side-backdrop) and below the sticky labels,
           and lets every pointer event reach what is underneath. -->
      <div class="tg-side-col" aria-hidden="true" />

      <!-- Grid lines for the visible window only (under the content) -->
      <div
        class="tg-gridlines"
        :style="{ left: ctx.gridLeft + 'px', width: (ctx.viewportCells + 1) * ctx.cellPx + 'px' }"
      >
        <div
          v-for="k in ctx.viewportCells + 1"
          :key="'gl' + k"
          class="tg-line"
          :style="{ left: (k - 1) * ctx.cellPx + 'px' }"
        />
      </div>

      <!-- Red ray of the current date: the boundary between "yesterday" and "today" -->
      <TodayLine :timeline="ctx" />

      <slot :t="ctx" />
    </div>

    <!-- Scale badge: pops up on Ctrl+wheel zoom -->
    <ScaleBadge :scale="ctx.scale" :bump="ctx.scaleBump" />
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.tg-scroll {
  overflow: auto;
  max-height: var(--planner-max-height, calc(100vh - 160px));
}
/* The side column of names is one opaque band for the whole visible height:
   the rows paint their own labels only where rows exist, so everywhere else the
   grid, the today line and the group backgrounds used to show through the
   column. The band is sticky (stays at the left edge while panning) and exactly
   as tall as the visible area — measured px divided by the zoom (--tg-fit-height),
   NOT a viewport unit or a percentage: everything inside .tg-content is
   multiplied by the zoom, so `100dvh` covers only half the column at 50% zoom.
   The negative margin keeps its flow contribution at zero. It never intercepts
   pointer events: panning, the context menu and bar interactions are unchanged. */
.tg-side-col {
  position: sticky;
  top: 0;
  left: 0;
  width: var(--label-width, 0px);
  height: var(--tg-fit-height, 0px);
  margin-bottom: calc(-1 * var(--tg-fit-height, 0px));
  background: var(--ui-surface);
  border-right: 1px solid var(--ui-border);
  box-sizing: border-box;
  z-index: var(--z-side-backdrop);
  pointer-events: none;
}
/* Resting state is the plain arrow cursor everywhere (headers, rows, the empty
   strip below the rows); the "drag hand" appears only while MMB panning. */
.tg-scroll.tg-panning,
.tg-scroll.tg-panning :deep(.gg-bars) {
  cursor: grabbing;
}
.tg-scroll.tg-panning :deep(*) {
  user-select: none;
  -webkit-user-select: none;
}
/* Not a percentage: everything inside .tg-content is multiplied by the zoom, so
   `min-height: 100%` shrinks the whole content box at zoom < 1 in engines that do
   not compensate the factor (Firefox) — the today line, the grid and the side
   column then end at half the visible height. --tg-fit-height is the measured
   container height divided by the scale, in local px. */
.tg-content {
  position: relative;
  min-height: var(--tg-fit-height, 0px);
}
.tg-gridlines {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: var(--z-grid);
  pointer-events: none;
}
.tg-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ui-border);
}
</style>
