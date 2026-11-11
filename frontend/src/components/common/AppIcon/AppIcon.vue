<script setup lang="ts">
import { computed } from 'vue'
import { APP_ICONS, type AppIconName } from './types'

const props = withDefaults(defineProps<{ name: AppIconName; size?: number }>(), { size: 18 })

// Path data for the requested icon; unknown names render nothing (defensive).
const paths = computed(() => APP_ICONS[props.name] ?? [])
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
svg {
  display: block;
  flex: none;
  /* Never clip the stroke at the viewBox edge: a glyph that slightly
     overflows keeps its full shape instead of being cut off */
  overflow: visible;
}
</style>