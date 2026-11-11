<script setup lang="ts">
import type { InfoTooltipProps } from './types'

withDefaults(defineProps<InfoTooltipProps>(), {
  title: '',
  lines: () => [],
  marker: null,
})
</script>

<template>
  <div class="it">
    <div v-if="title" class="it-head">
      <span v-if="marker" class="it-marker" :style="{ background: marker }" />
      <span class="it-title">{{ title }}</span>
    </div>
    <div
      v-for="(line, i) in lines"
      :key="i"
      class="it-line"
      :class="{ 'it-line--marker': !title && i === 0 && marker }"
    >
      <span v-if="!title && i === 0 && marker" class="it-marker" :style="{ background: marker }" />
      <span>{{ line }}</span>
    </div>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.it {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.it-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 2px;
}
.it-title {
  font-weight: 700;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  white-space: nowrap;
}
.it-line {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ui-text-2);
  white-space: nowrap;
}
.it-marker {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  flex-shrink: 0;
}
</style>
