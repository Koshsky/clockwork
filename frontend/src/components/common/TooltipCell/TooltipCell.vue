<script setup lang="ts">
import { ref, useSlots, onBeforeUnmount } from 'vue'
import type { TooltipCellProps } from './types'

const props = withDefaults(defineProps<TooltipCellProps>(), {
  multiline: false,
  disabled: false,
})

const emit = defineEmits<{
  /** Popover became visible (after the hover delay) — for lazy content loading */
  open: []
}>()

const visible = ref(false)
const x = ref(0)
const y = ref(0)
let showTimer: ReturnType<typeof setTimeout> | null = null
const triggerRef = ref<HTMLElement | null>(null)
const popupRef = ref<HTMLElement | null>(null)
const slots = useSlots()

const PAD = 12

/** Position the popover at the cursor: below-right, clamped to the window bounds */
function positionAt(e: MouseEvent) {
  let left = e.clientX + PAD
  let top = e.clientY + PAD
  const el = popupRef.value
  if (el) {
    const rect = el.getBoundingClientRect()
    left = Math.min(left, window.innerWidth - rect.width - 8)
    top = Math.min(top, window.innerHeight - rect.height - 8)
  }
  x.value = Math.max(8, left)
  y.value = Math.max(8, top)
}

function onMouseEnter(e: MouseEvent) {
  // Disabled (e.g. during a range drag): do not open the popup at all
  if (props.disabled) return
  positionAt(e)
  showTimer = setTimeout(() => {
    visible.value = true
    emit('open')
  }, 400)
}

function onMouseMove(e: MouseEvent) {
  if (!visible.value) return
  positionAt(e)
}

function onMouseLeave() {
  if (showTimer) clearTimeout(showTimer)
  visible.value = false
}

onBeforeUnmount(() => {
  if (showTimer) clearTimeout(showTimer)
})
</script>

<template>
  <span
    ref="triggerRef"
    class="tt-trigger"
    @mouseenter="onMouseEnter"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="visible && (text || slots.popup)"
        ref="popupRef"
        class="tt-popup"
        :class="{ 'tt-popup--multiline': multiline }"
        :style="{ left: x + 'px', top: y + 'px' }"
      >
        <slot name="popup">
          {{ text }}
        </slot>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.tt-popup {
  position: fixed;
  background: var(--ui-surface);
  color: var(--ui-text);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1.45;
  padding: 8px 12px;
  border-radius: var(--ui-radius-sm);
  border: 1px solid var(--ui-border);
  white-space: nowrap;
  pointer-events: none;
  z-index: 9999;
  box-shadow: var(--ui-shadow-md);
}
.tt-popup--multiline {
  /* Stretch the backdrop to fit all content (nowrap lines must not overflow the edge) */
  width: max-content;
  max-width: none;
  white-space: normal;
}
</style>
