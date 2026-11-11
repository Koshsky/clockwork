<script setup lang="ts">
import { computed } from 'vue'
import { cellIndexForDate } from '../../../../../calendar'
import { linkArrow } from '@/components/planner/dependencyPaths'
import { viewSettings } from '@/settings'
import type { TaskDependencyLinksProps, DependencyArrow } from './types'

const props = withDefaults(defineProps<TaskDependencyLinksProps>(), {
  dependencies: () => [],
})

/** The user's choice in Settings (override wins, for the stories). */
const connector = computed(() => props.connector ?? viewSettings.connector)

/** Row geometry: the milestone strip takes 20px on top, rows are 26px high. */
const ROW_H = 26
const TOP_PAD = 20
/** Bars are drawn with a tiny inset from the cell edge. */
const BAR_INSET = 2

/** Row center Y of a task (top-level row index). */
const rowIndex = computed(() => {
  const m = new Map<number, number>()
  props.tasks.forEach((t, i) => m.set(t.id, i))
  return m
})

/** Absolute pixel X of a DATE's cell in the group container coordinates. */
function cellX(date: string): number {
  const idx = cellIndexForDate(props.timeline.origin, props.timeline.unit, date)
  return props.timeline.cellLeft(idx)
}

/** X of the bar's left edge (start date cell, small inset). */
function leftX(t: { start_date: string }): number {
  return cellX(t.start_date) + BAR_INSET
}

/** X of the bar's right edge (end date cell + cell width, small inset). */
function rightX(t: { end_date: string }): number {
  return cellX(t.end_date) + props.timeline.cellPx - BAR_INSET
}

/**
 * Connectors between the process's top-level tasks: one line per link in the
 * user's chosen style (Settings → Diagrams), terminated by a tick on the date
 * the link constrains (fs/ss — the successor's start edge, ff/sf — its end
 * edge). The anchors of the four types follow the constraint engine, see
 * `planner/dependencyPaths.ts`. Rows/bars only exist for top-level tasks, so
 * links involving other rows are skipped.
 */
const arrows = computed<DependencyArrow[]>(() => {
  const out: DependencyArrow[] = []
  const idx = rowIndex.value
  for (const e of props.dependencies) {
    const predIdx = idx.get(e.depends_on_task_id)
    const succIdx = idx.get(e.task_id)
    if (predIdx == null || succIdx == null) continue
    const pred = props.tasks[predIdx]
    const succ = props.tasks[succIdx]

    const arrow = linkArrow(
      {
        type: e.type,
        predStartX: leftX(pred),
        predEndX: rightX(pred),
        succStartX: leftX(succ),
        succEndX: rightX(succ),
        predY: TOP_PAD + predIdx * ROW_H + ROW_H / 2,
        succY: TOP_PAD + succIdx * ROW_H + ROW_H / 2,
      },
      connector.value,
    )
    out.push({ key: `${e.id}`, d: arrow.d, tick: arrow.tick })
  }
  return out
})
</script>

<template>
  <svg
    v-if="arrows.length"
    class="tdl-links"
    aria-hidden="true"
  >
    <path
      v-for="a in arrows"
      :key="a.key"
      class="tdl-path"
      :d="a.d"
    />
    <path
      v-for="a in arrows"
      :key="'tick' + a.key"
      class="tdl-tick"
      :d="a.tick"
    />
  </svg>
</template>

<style scoped>
@import "../../../../../../../styles/tokens.css";
.tdl-links {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  z-index: var(--z-content-top);
}
.tdl-path {
  fill: none;
  stroke: var(--ui-text-muted);
  /* Thicker than a hairline on purpose: the curve crosses bars and row
     dividers without a halo, so its weight carries the readability. */
  stroke-width: 2.5;
  stroke-linecap: round;
}
/* Terminus mark: the link stops on this date instead of pointing at it. */
.tdl-tick {
  fill: none;
  stroke: var(--ui-text-muted);
  stroke-width: 3;
  stroke-linecap: round;
}
</style>
