<script setup lang="ts">
import { computed } from 'vue'
import type { TimesheetCellProps } from './types'
import { stateBackground } from '../stateColors'
import { TooltipCell } from '@/components/common/TooltipCell'
import { InfoTooltip } from '@/components/common/Tooltips'
import { t } from '@/i18n'

const props = withDefaults(defineProps<TimesheetCellProps>(), {
  state: null,
  isWeekend: false,
  selected: false,
  showText: false,
  selectionRange: null,
  tooltipDisabled: false,
})

/** The state's own color from the catalog (when set), else null — the caller
 *  falls back to the palette via stateBackground. */
function stateColor(stateId: number | undefined): string | null {
  return stateId != null ? (props.colorMap?.[stateId] ?? null) : null
}

const bg = computed<string>(() => {
  const s = props.state
  if (!s) {
    return props.isWeekend ? 'var(--ui-usage-weekend)' : 'transparent'
  }
  return stateColor(s.state_id) ?? stateBackground(s.state_code, s.is_available, s.state_id)
})

function fmtDM(iso?: string): string {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${d}.${m}`
}

function fmtFull(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** Colored state marker (no marker for an empty day) */
const marker = computed<string | null>(() => {
  const s = props.state
  if (!s) return null
  return stateColor(s.state_id) ?? stateBackground(s.state_code, s.is_available, s.state_id)
})

const period = computed(() => {
  const s = props.state
  if (!s) return ''
  return `${fmtDM(s.start_date)}–${fmtDM(s.end_date)}`
})

const emptyLabel = computed(() => (props.isWeekend ? t('timesheet.cell.weekend') : t('timesheet.cell.workday')))
</script>

<template>
  <TooltipCell class="tsc" :multiline="true" :disabled="tooltipDisabled">
    <div
      class="tsc-inner"
      :class="{ 'tsc--selected': selected, 'tsc--show-text': showText }"
      :style="{ background: bg }"
    >
      <span v-if="showText && state" class="tsc-code">{{ state.state_code }}</span>
    </div>
    <template #popup>
      <!-- While the cell is part of an active selection, show the fragment date
           range instead of the per-day info (assignment feedback) -->
      <InfoTooltip
        v-if="selectionRange"
        :title="t('timesheet.cell.selection')"
        :lines="[`${fmtFull(selectionRange.start)} — ${fmtFull(selectionRange.end)}`]"
      />
      <InfoTooltip
        v-else
        :title="state ? state.state_name : emptyLabel"
        :lines="state ? [period] : []"
        :marker="marker"
      />
    </template>
  </TooltipCell>
</template>

<style scoped>
@import '../../../styles/tokens.css';

.tsc {
  display: flex;
  width: 100%;
  height: 100%;
  cursor: cell;
}
.tsc-inner {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  box-sizing: border-box;
}
.tsc--selected {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
  z-index: var(--z-bar);
}
.tsc-code {
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 700;
  color: rgba(0, 0, 0, 0.55);
  pointer-events: none;
  white-space: nowrap;
}
</style>
