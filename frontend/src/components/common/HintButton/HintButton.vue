<script setup lang="ts">
import { computed } from 'vue'
import { openHintPage, hintOpen, hintPageRef } from '@/composables/useHints'
import { hintPage } from '@/hints/registry'
import { t } from '../../../i18n'

const props = withDefaults(defineProps<{
  /** Hint page id from the central registry (src/hints/registry.ts). */
  hint: string
  /** Custom accessible name; defaults to the page title from the registry. */
  title?: string
  size?: 'sm' | 'md'
}>(), {
  title: undefined,
  size: 'sm',
})

const label = computed(() => props.title ?? hintPage(props.hint)?.title ?? props.hint)
/** Whether the side panel is open exactly with this hint page. */
const expanded = computed(() => hintOpen.value && hintPageRef.value === props.hint)
</script>

<template>
  <button
    type="button"
    class="hb"
    :class="`is-${size}`"
    :aria-label="t('ui.hint.aria', { label })"
    aria-haspopup="dialog"
    :aria-expanded="expanded"
    @click="openHintPage(hint)"
  >?</button>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.hb {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: var(--ui-radius-sm);
  border: 2px solid var(--ui-accent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-size: calc(var(--ui-font-scale, 1) * 17px);
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.14);
  transition: background var(--ui-duration), color var(--ui-duration), transform 0.1s;
}
.hb:hover {
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  transform: scale(1.06);
}
.hb[aria-expanded="true"] {
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  border-color: var(--ui-accent);
}
.hb.is-sm {
  width: 26px;
  height: 26px;
  font-size: calc(var(--ui-font-scale, 1) * 15px);
}
</style>