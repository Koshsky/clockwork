<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted } from 'vue'
import type { ContextMenuProps } from './types'

const props = defineProps<ContextMenuProps>()

const emit = defineEmits<{
  select: [id: string]
  close: []
}>()

const menuRef = ref<HTMLElement | null>(null)

function clampPos(): { x: number; y: number } {
  const el = menuRef.value
  if (!el) return { x: props.x, y: props.y }
  const { innerWidth, innerHeight } = window
  const rect = el.getBoundingClientRect()
  const x = Math.min(props.x, innerWidth - rect.width - 8)
  const y = Math.min(props.y, innerHeight - rect.height - 8)
  return { x: Math.max(8, x), y: Math.max(8, y) }
}

const style = ref<Record<string, string>>({})

watch(
  () => [props.open, props.x, props.y] as const,
  () => {
    if (!props.open) return
    style.value = {
      position: 'fixed',
      left: '0px',
      top: '0px',
      visibility: 'hidden',
    }
    requestAnimationFrame(() => {
      const p = clampPos()
      style.value = { position: 'fixed', left: p.x + 'px', top: p.y + 'px' }
    })
  },
  { immediate: true },
)

function onDocClick(e: MouseEvent) {
  if (!props.open) return
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) emit('close')
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

function onDocScroll() {
  if (props.open) emit('close')
}

function onSelect(id: string) {
  emit('select', id)
  emit('close')
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onDocKey)
  document.addEventListener('scroll', onDocScroll, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onDocKey)
  document.removeEventListener('scroll', onDocScroll, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="cm"
      :style="style"
      role="menu"
      @contextmenu.prevent
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="cm-item"
        :class="{ 'cm-item--active': item.active }"
        role="menuitem"
        @click="onSelect(item.id)"
      >
        <span v-if="item.active" class="cm-check">✓</span>
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.cm {
  z-index: 50000;
  min-width: 180px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-md);
  padding: 4px;
}
.cm-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 8px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--ui-duration), color var(--ui-duration);
}
.cm-item:hover {
  background: var(--ui-success-soft);
  color: var(--ui-success);
}
.cm-item--active {
  color: var(--ui-success);
  font-weight: 600;
}
.cm-check {
  display: inline-block;
  width: 16px;
  margin-left: -4px;
}
</style>
