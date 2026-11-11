<script setup lang="ts">
import { computed } from 'vue'
import { cellIndexForDate } from '../calendar'
import { DAY_MS } from '../../../utils'
import type { TodayLineProps } from './types'

const props = withDefaults(defineProps<TodayLineProps>(), {
  color: 'var(--ui-today)',
  width: 2,
  offset: 0,
})

/** Absolute index of the cell containing today */
const todayIdx = computed(() =>
  cellIndexForDate(props.timeline.origin, props.timeline.unit, new Date()),
)
/** The ray hides outside the visible window (±margin, like bars) */
const visible = computed(() => {
  const t = props.timeline
  return todayIdx.value > t.windowStart - 4 && todayIdx.value < t.windowStart + t.viewportCells + 4
})

/**
 * Position of the "yesterday/today" boundary in content pixels:
 * day — the left edge of the "today" cell (day boundary); decade/week — the
 * fractional position of the current day inside the multi-day cell.
 */
const left = computed<number | null>(() => {
  if (!visible.value) return null
  const t = props.timeline
  const i = todayIdx.value
  const frac =
    t.unit === 'day'
      ? 0
      : (new Date().getTime() - t.cellStart(i).getTime()) / (t.cellEnd(i).getTime() - t.cellStart(i).getTime() + DAY_MS)
  return t.cellLeft(i) + frac * t.cellPx + props.offset
})

/** Week highlight: a full-column tint behind the today line (week unit only). */
const band = computed<{ left: string; width: string } | null>(() => {
  if (!visible.value || props.timeline.unit !== 'week') return null
  const t = props.timeline
  return { left: t.cellLeft(todayIdx.value) + 'px', width: t.cellPx + 'px' }
})

const lineStyle = computed<Record<string, string> | null>(() =>
  left.value != null
    ? {
        left: left.value + 'px',
        width: props.width + 'px',
        background: props.color,
      }
    : null,
)
</script>

<template>
  <div v-if="band" class="tl-band" :style="band" />
  <div v-if="lineStyle" class="tl-line" :style="lineStyle" />
</template>

<style scoped>
@import "../../../styles/tokens.css";
/* Full-column highlight of the current week: a faint tint under the line. */
.tl-band {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: var(--z-today);
  pointer-events: none;
  background: color-mix(in srgb, var(--ui-today) 8%, transparent);
}
.tl-line {
  position: absolute;
  top: 0;
  bottom: 0;
  /* Its own level: above the content (--z-bar, --z-content-top), the resource
     cells (--z-resource-cells) and the calendar header (--z-header) — the line
     crosses the header on top. Still below the scale badge (--z-scale-badge)
     and the side-panel label layers (--z-side-row, --z-side-merged,
     --z-side-panel, --z-corner), and below popups. The label layers never
     overlap the line in X (it starts after LABEL_WIDTH), but keep the ordering
     strict anyway. The whole ladder is documented in styles/tokens.css. */
  z-index: var(--z-today);
  pointer-events: none;
}
</style>
