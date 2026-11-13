<script setup lang="ts">
import { computed } from 'vue'
import { fmtDate } from '@/components/planner/calendar'
import { resourceAbsencesInRange, resourceCellUsage } from '@/domain/resourceUsage'
import TooltipCell from '../TooltipCell/TooltipCell.vue'
import { InfoTooltip } from '../Tooltips'
import UsageCell from '../UsageCell/UsageCell.vue'
import type { TimelineCtx } from '@/composables/timeline-context'
import { LABEL_WIDTH, headerHeight } from '@/components/planner/layout'
import type { DtoResourceAbsenceResponse } from '@/api'
import type { Resource } from './types'
// `t` is the timeline context prop of this component, so the translator is aliased.
import { t as translate } from '../../../i18n'

const props = defineProps<{
  t: TimelineCtx
  resources: Resource[]
  usageFn: (resourceId: number, day: Date) => number
  availableFn: (resourceId: number, day: Date) => number | null
  /** Resource member absences by id (for the UsageCell tooltip) */
  absenceByResource?: Record<number, DtoResourceAbsenceResponse[]> | null
}>()

interface CellUsage {
  used: number
  available: number | null
  isWeekend: boolean
  absentees: DtoResourceAbsenceResponse[]
}

/** Resource absences overlapping at least one day of the cell range */
function cellAbsentees(resourceId: number, start: Date, end: Date): DtoResourceAbsenceResponse[] {
  const list = props.absenceByResource?.[resourceId]
  if (!list?.length) return []
  return resourceAbsencesInRange(list, start, end)
}

function cellUsage(resourceId: number, start: Date, end: Date): CellUsage {
  return {
    ...resourceCellUsage(resourceId, start, end, props.usageFn, props.availableFn),
    absentees: cellAbsentees(resourceId, start, end),
  }
}

// Dates and geometry belong to a column, not to each resource in that column.
const visibleCells = computed(() => props.t.visibleIndices.map((index) => {
  const start = props.t.cellStart(index)
  const date = fmtDate(start)
  return { start, end: props.t.cellEnd(index), date, left: props.t.cellLeft(index) + 'px', contextKey: props.t.unit + ':' + date }
}))

/** Usage per resource and visible cell (peak daily load inside a cell) */
const resourceCells = computed(() =>
  props.resources.map((res) => ({
    res,
    cells: visibleCells.value.map((cell) => cellUsage(res.id, cell.start, cell.end)),
  })),
)

/** Cells too narrow — hide the text (resource codes and load numbers)
 *  but keep the colored cell block visible */
const showText = computed(() => props.t.cellPx >= 12)

/** Resource row height and total code-layer height (for the negative margin) */
const rowH = computed(() => (showText.value ? 18 : 9))
const labelsH = computed(() => resourceCells.value.length * rowH.value)
</script>

<template>
  <!-- Resource code layer: a separate sticky side-panel element (--z-side-panel),
       outside the resource block's stacking context — above the current-date line
       (--z-today) -->
  <div
    class="rs-labels"
    :style="{
      top: headerHeight(t.unit, t.cellPx) + 'px',
      width: LABEL_WIDTH + 'px',
      height: labelsH + 'px',
      marginBottom: '-' + labelsH + 'px',
    }"
  >
    <div
      v-for="rc in resourceCells"
      :key="'rl' + rc.res.id"
      class="rs-label"
      :class="{ 'rs-label--compact': !showText }"
    >
      <TooltipCell v-if="showText" :multiline="true">
        <span class="rs-code">{{ rc.res.code }}</span>
        <template #popup>
          <InfoTooltip :title="rc.res.title" :lines="[translate('ui.resource.total', { count: rc.res.employeesCount })]" />
        </template>
      </TooltipCell>
    </div>
  </div>

  <!-- Load-cell block "4/5": sticks below the calendar header, under the current-date line -->
  <div class="rs-block" :style="{ top: headerHeight(t.unit, t.cellPx) + 'px' }">
    <template v-for="rc in resourceCells" :key="'r' + rc.res.id">
      <div class="rs-row" :class="{ 'rs-row--compact': !showText }">
        <div
          v-for="(u, k) in rc.cells"
          :key="k"
          class="rs-cell"
          :data-resource-id="rc.res.id"
          :data-date="visibleCells[k].date"
          :style="{ left: visibleCells[k].left, width: t.cellPx + 'px' }"
        >
          <UsageCell :used="u.used" :available="u.available" :isWeekend="u.isWeekend" :show-text="showText" :absentees="u.absentees" :context-key="visibleCells[k].contextKey" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";

/* Resource code layer — side panel: sticks to the left and top edges (below the
 * calendar header), sits above the current-date line (--z-today). Height and
 * negative margin are set inline so the cell block is not shifted. */
.rs-labels {
  position: sticky;
  left: 0;
  background: var(--ui-surface);
  z-index: var(--z-side-panel);
  box-sizing: border-box;
}
.rs-label {
  height: 18px;
  display: flex;
  align-items: center;
  padding: 0 6px;
  box-sizing: border-box;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  border-bottom: 1px solid var(--ui-border);
}
.rs-label--compact {
  height: 9px;
}
.rs-code {
  font-weight: 700;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  letter-spacing: 0.5px;
}
/* Load-cell block "4/5": sticks right below the calendar header.
 * --z-resource-cells — above the content (--z-bar, --z-content-top), but below the
 * current-date line (--z-today). The ladder itself lives in styles/tokens.css. */
.rs-block {
  position: sticky;
  z-index: var(--z-resource-cells);
  background: var(--ui-surface);
}
.rs-row {
  position: relative;
  height: 18px;
  background: var(--ui-surface);
}
/* Text hidden (narrow cells) — the resource row is twice as thin, only the fill remains */
.rs-row--compact {
  height: 9px;
}
.rs-cell {
  position: absolute;
  top: 0;
  bottom: 0;
  padding: 0;
  background: var(--ui-surface);
}
</style>
