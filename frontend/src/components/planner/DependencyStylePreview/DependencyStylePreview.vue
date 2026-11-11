<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import { linkArrow } from '../dependencyPaths'
import { LINK_STYLE_DEFAULT } from '../linkStyle'
import { linkStyleLabel } from '../linkStyleLabels'
import type { DependencyStylePreviewProps } from './types'

const props = withDefaults(defineProps<DependencyStylePreviewProps>(), {
  connector: LINK_STYLE_DEFAULT,
})

/**
 * Fixed demo scene for the settings screen: three bars and two links, chosen so
 * that both tick positions are visible (fs arrives at the successor's START
 * edge, ff at its END edge). The geometry is the planner's own `linkArrow`, so
 * the preview cannot promise a line the diagram would not draw.
 */
const VIEW_W = 356
const VIEW_H = 116
const BAR_H = 22
/** Row centers (the demo uses one task per row, like the planner). */
const ROW_Y = [24, 62, 100]
const BARS = [
  { x: 8, w: 90 },
  { x: 128, w: 90 },
  { x: 200, w: 90 },
]

const LINKS = [
  { type: 'fs' as const, pred: 0, succ: 1 },
  { type: 'ff' as const, pred: 1, succ: 2 },
]

const arrows = computed(() =>
  LINKS.map((l) => {
    const pred = BARS[l.pred]
    const succ = BARS[l.succ]
    return linkArrow(
      {
        type: l.type,
        predStartX: pred.x,
        predEndX: pred.x + pred.w,
        succStartX: succ.x,
        succEndX: succ.x + succ.w,
        predY: ROW_Y[l.pred],
        succY: ROW_Y[l.succ],
      },
      props.connector,
    )
  }),
)

const bars = computed(() =>
  BARS.map((bar, i) => ({ ...bar, y: ROW_Y[i] - BAR_H / 2 })),
)

const ariaLabel = computed(() =>
  t('adminSystem.settings.defaults.connectorPreviewAria', { style: linkStyleLabel(props.connector) }),
)
</script>

<template>
  <svg
    class="dsp-preview"
    :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
    role="img"
    :aria-label="ariaLabel"
  >
    <rect
      v-for="(bar, i) in bars"
      :key="'bar' + i"
      class="dsp-bar"
      :x="bar.x"
      :y="bar.y"
      :width="bar.w"
      :height="BAR_H"
      rx="5"
    />
    <path
      v-for="(a, i) in arrows"
      :key="'line' + i"
      class="dsp-line"
      :d="a.d"
    />
    <path
      v-for="(a, i) in arrows"
      :key="'tick' + i"
      class="dsp-tick"
      :d="a.tick"
    />
  </svg>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.dsp-preview {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 356px;
  height: auto;
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
}
/* Same weight as the diagram overlay: the preview must not promise another line. */
.dsp-bar {
  fill: var(--ui-gantt-task);
  opacity: 0.75;
}
.dsp-line {
  fill: none;
  stroke: var(--ui-text-muted);
  stroke-width: 2.5;
  stroke-linecap: round;
}
.dsp-tick {
  fill: none;
  stroke: var(--ui-text-muted);
  stroke-width: 3;
  stroke-linecap: round;
}
</style>
