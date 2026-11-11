<script setup lang="ts">
import { computed } from 'vue'
import type { TimelineCtx } from '../../../composables/timeline-context'
import { cellIndexForDate, isoWeek, weekCoordinate } from '../calendar'
import { appLocale } from '@/i18n'
import { dateLocale, fmtDateRange, fmtMonthLong, weekdayShort } from '@/i18n/date'
import {
  LABEL_WIDTH,
  headerHeight,
  CELL_PX_NUM_DAY,
  CELL_PX_NUM_DECADE,
  CELL_PX_NUM_WEEK,
  CELL_PX_WD_DAY,
  CELL_PX_WEEK_DATES,
} from '../layout'

const props = defineProps<{
  t: TimelineCtx
}>()

/** Short weekday names indexed by `Date.getDay()` — follow the interface language */
const dowMap = computed(() => weekdayShort(appLocale.value))

/** Cell number label: day — the number; decade — the day range (1-10, 11-20, 21-end);
 *  week — the ISO 8601 week number. */
function numLabel(i: number): string {
  if (props.t.unit === 'week') {
    return new Intl.NumberFormat(dateLocale()).format(isoWeek(props.t.cellStart(i)).week)
  }
  const s = props.t.cellStart(i)
  const e = props.t.cellEnd(i)
  return s.getDate() === e.getDate() ? s.getDate().toString() : `${s.getDate()}-${e.getDate()}`
}

function monthLabel(d: Date): string {
  const m = fmtMonthLong(d)
  return m.charAt(0).toUpperCase() + m.slice(1) + ' ' + d.getFullYear()
}

/** Months with merged cells — the label is centered over the FULL month width
 *  (from the month's first to last cell), not the visible window, so it does not "float" while scrolling */
const monthGroups = computed(() => {
  const out: { key: string; label: string; from: number; to: number }[] = []
  if (props.t.unit === 'week' && props.t.visibleIndices.length) {
    const first = props.t.cellStart(props.t.visibleIndices[0])
    const last = props.t.cellEnd(props.t.visibleIndices[props.t.visibleIndices.length - 1])
    for (let d = new Date(first.getFullYear(), first.getMonth(), 1); d <= last;
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1)
      out.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: monthLabel(d),
        from: weekCoordinate(props.t.origin, d), to: weekCoordinate(props.t.origin, next) })
    }
    return out
  }
  const seen = new Set<string>()
  for (const i of props.t.visibleIndices) {
    const d = props.t.cellStart(i)
    const key = d.getFullYear() + '-' + d.getMonth()
    if (seen.has(key)) continue
    seen.add(key)
    const firstOfMonth = cellIndexForDate(props.t.origin, props.t.unit, new Date(d.getFullYear(), d.getMonth(), 1))
    const lastOfMonth = cellIndexForDate(props.t.origin, props.t.unit, new Date(d.getFullYear(), d.getMonth() + 1, 0))
    out.push({ key, label: monthLabel(d), from: firstOfMonth, to: lastOfMonth + 1 })
  }
  return out
})

/** The number and weekday rows are hidden when the cell is too narrow for their labels */
const numRowThreshold = computed(() =>
  props.t.unit === 'day' ? CELL_PX_NUM_DAY : props.t.unit === 'week' ? CELL_PX_NUM_WEEK : CELL_PX_NUM_DECADE,
)
const showNumRow = computed(() => props.t.cellPx >= numRowThreshold.value)
const showWdRow = computed(() => props.t.unit === 'day' && props.t.cellPx >= CELL_PX_WD_DAY)
const showWeekDates = computed(() => props.t.unit === 'week' && props.t.cellPx >= CELL_PX_WEEK_DATES)

function weekDates(i: number): string {
  const formatter = new Intl.DateTimeFormat(dateLocale(), { day: '2-digit', month: '2-digit' })
  return `${formatter.format(props.t.cellStart(i))}–${formatter.format(props.t.cellEnd(i))}`
}

/**
 * Left border of a header cell. The window's first cell (windowStart) starts at or
 * left of the column edge, and the corner cell already draws that line: with the
 * scroll aligned to the cell grid (the default "scroll to today") both 1px lines
 * land side by side at the joint, which looks twice as thick as any other grid
 * line. Every cell further right keeps its own border.
 */
function edgeBorder(i: number): string | undefined {
  return i <= props.t.windowStart ? 'none' : undefined
}
</script>

<template>
  <div class="th-corner"
    :style="{
      width: LABEL_WIDTH + 'px',
      height: headerHeight(t.unit, t.cellPx) + 'px',
      marginBottom: '-' + headerHeight(t.unit, t.cellPx) + 'px',
    }"></div>
  <div class="tg-head" :style="{ height: headerHeight(t.unit, t.cellPx) + 'px' }">

    <div v-for="m in monthGroups" :key="m.key"
      class="th-month"
      :style="{ left: t.cellLeft(m.from) + 'px', width: (m.to - m.from) * t.cellPx + 'px' }">
      {{ m.label }}
    </div>

    <template v-if="showNumRow">
      <div v-for="i in t.visibleIndices" :key="'n' + i"
        class="th-num"
        :title="t.unit === 'week' ? fmtDateRange(t.cellStart(i), t.cellEnd(i)) : undefined"
        :style="{ left: t.cellLeft(i) + 'px', width: t.cellPx + 'px', borderLeft: edgeBorder(i) }">
        {{ numLabel(i) }}
      </div>
    </template>

    <template v-if="showWeekDates">
      <div v-for="i in t.visibleIndices" :key="'range' + i"
        class="th-wd"
        :style="{ left: t.cellLeft(i) + 'px', width: t.cellPx + 'px', borderLeft: edgeBorder(i) }">
        {{ weekDates(i) }}
      </div>
    </template>

    <template v-if="showWdRow">
      <div v-for="i in t.visibleIndices" :key="'w' + i"
        class="th-wd"
        :style="{ left: t.cellLeft(i) + 'px', width: t.cellPx + 'px', borderLeft: edgeBorder(i) }">
        {{ dowMap[t.cellStart(i).getDay()] }}
      </div>
    </template>
  </div>
</template>

<style scoped>
@import '../../../styles/tokens.css';
.tg-head {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  background: var(--ui-surface-2);
}
/* Bottom edge of the header: the same 1px line the corner cell draws, so the two
   meet without a step. Painted as a pseudo-element over the cell backgrounds
   rather than as a border: a border would either change the height or be covered
   by the rows' own backgrounds in the collapsed header states (20/38px). */
.tg-head::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--ui-border);
}
/* Corner — part of the side panel: sticks to the left and top edges, sits above
 * all side-panel layers (--z-side-row, --z-side-merged, --z-side-panel) and the
 * today line (--z-today), but outside the header stacking context (--z-header).
 * Otherwise on vertical scroll group labels pass over it — the corner looks like
 * a "punched-out window". Height and negative margin are set inline so the
 * header is not shifted. The ladder itself lives in styles/tokens.css. */
.th-corner {
  position: sticky;
  top: 0;
  left: 0;
  /* Width comes from LABEL_WIDTH through the inline style (see the template) —
     never repeat the number here, the side panel is built from the same one. */
  background: var(--ui-surface-2);
  z-index: var(--z-corner);
  display: flex;
  align-items: center;
  padding: 0 10px;
  box-sizing: border-box;
  font-weight: 700;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-2);
  border-right: 1px solid var(--ui-border);
  border-bottom: 1px solid var(--ui-border);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.th-month {
  position: absolute;
  top: 2px;
  height: 18px;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 600;
  color: var(--ui-text-2);
  overflow: hidden;
  white-space: nowrap;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ui-surface-2);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.th-num {
  position: absolute;
  top: 20px;
  height: 18px;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  color: var(--ui-text-2);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-surface-2);
  overflow: hidden;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
.th-wd {
  position: absolute;
  top: 36px;
  height: 18px;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  color: var(--ui-text-muted);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  border-left: 1px solid var(--ui-border);
  background: var(--ui-surface-2);
  overflow: hidden;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
}
</style>
