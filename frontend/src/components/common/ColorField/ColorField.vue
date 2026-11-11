<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../../../i18n'
import { COLOR_PALETTE, PALETTE_HUES, PALETTE_SHADES } from './palette'
import type { ColorFieldProps } from './types'

const props = withDefaults(defineProps<ColorFieldProps>(), {
  label: '',
  size: 'md',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

// === Trigger ===
const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const open = ref(false)

/** Swatches shown in the popover: row-major over (shade × hue) so each of the
 *  8 columns is one hue family and rows go from light (top) to deep (bottom). */
const swatches = computed(() => {
  const list: Array<{ color: string; isSelected: boolean }> = []
  for (let shade = 0; shade < PALETTE_SHADES; shade++) {
    for (let hue = 0; hue < PALETTE_HUES; hue++) {
      const color = COLOR_PALETTE[hue][shade] ?? ''
      list.push({ color, isSelected: color === props.modelValue })
    }
  }
  return list
})

/** The flexible palette icon — a small SVG with a rainbow gradient circle. */
const paletteIconId = 'cf-rainbow'

/** Popover placed under the trigger, clamped to the viewport (mirrors ContextMenu). */
const panelStyle = ref<Record<string, string>>({})

function clampPanel() {
  const panel = panelRef.value
  const trigger = triggerRef.value
  if (!panel || !trigger) return
  const tr = trigger.getBoundingClientRect()
  const pr = panel.getBoundingClientRect()
  const gap = 6
  let left = tr.left
  let top = tr.bottom + gap
  if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8
  if (left < 8) left = 8
  if (top + pr.height > window.innerHeight - 8) top = tr.top - pr.height - gap
  if (top < 8) top = 8
  panelStyle.value = { position: 'fixed', left: left + 'px', top: top + 'px' }
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    close()
  } else {
    open.value = true
  }
}

watch(() => props.disabled, (disabled) => {
  if (disabled) close()
})

watch(open, (isOpen) => {
  if (!isOpen) return
  panelStyle.value = { position: 'fixed', left: '0px', top: '0px', visibility: 'hidden' }
  requestAnimationFrame(clampPanel)
})

function select(color: string) {
  if (props.disabled) return
  if (color !== props.modelValue) emit('update:modelValue', color)
  close()
}

function clear() {
  if (props.disabled) return
  if (props.modelValue !== '') emit('update:modelValue', '')
  close()
}

function close() {
  open.value = false
}

// === Flexible palette (native color input) ===
const flexInputRef = ref<HTMLInputElement | null>(null)

function openFlexPalette() {
  if (props.disabled) return
  flexInputRef.value?.click()
}

function onFlexInput() {
  const v = flexInputRef.value?.value
  if (v) select(v)
}

// === Outside click / Escape / scroll close ===
function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const root = triggerRef.value?.closest('.cf-root') as HTMLElement | null
  if (root && root.contains(e.target as Node)) return
  if (panelRef.value && panelRef.value.contains(e.target as Node)) return
  close()
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

function onDocScroll() {
  if (open.value) close()
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

/** Trigger circle background; empty value → outlined "standard color" circle. */
const triggerStyle = computed<Record<string, string>>(() => {
  const size = props.size === 'sm' ? 20 : 28
  const style: Record<string, string> = { width: size + 'px', height: size + 'px' }
  if (props.modelValue) {
    style.background = props.modelValue
  }
  return style
})

const panelSizeClass = computed(() => (props.size === 'sm' ? 'cf-panel--sm' : ''))
</script>

<template>
  <div class="cf-root">
    <button
      ref="triggerRef"
      type="button"
      class="cf-trigger"
      :disabled="disabled"
      :class="{ 'cf-trigger--empty': !modelValue, 'is-open': open }"
      :style="triggerStyle"
      :aria-label="label ? label : t('ui.color.label')"
      :title="modelValue ? t('ui.color.titleChange', { value: modelValue }) : t('ui.color.titleEmpty')"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
    />

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="cf-panel"
        :class="panelSizeClass"
        :style="panelStyle"
        role="dialog"
        :aria-label="label ? t('ui.color.ariaWithLabel', { label }) : t('ui.color.paletteOpen')"
      >
        <div class="cf-grid">
          <button
            v-for="(sw, i) in swatches"
            :key="sw.color + i"
            type="button"
            class="cf-swatch"
            :class="{ 'is-selected': sw.isSelected }"
            :style="{ background: sw.color }"
            :title="sw.color"
            :aria-label="t('ui.color.ariaSwatch', { value: sw.color })"
            @click="select(sw.color)"
          />
        </div>

        <div class="cf-footer">
          <button type="button" class="cf-clear" @click="clear">
            <span class="cf-clear-swatch" />
            {{ t('ui.color.none') }}
          </button>
          <button
            type="button"
            class="cf-flex"
            :title="t('ui.color.paletteTitle')"
            :aria-label="t('ui.color.paletteOpen')"
            @click="openFlexPalette"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <defs>
                <linearGradient :id="paletteIconId" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#ef4444" />
                  <stop offset="0.33" stop-color="#f59e0b" />
                  <stop offset="0.66" stop-color="#22c55e" />
                  <stop offset="1" stop-color="#3b82f6" />
                </linearGradient>
              </defs>
              <circle cx="12" cy="12" r="9" fill="url(#cf-rainbow)" />
              <path d="M12 3v18M3 12h18" stroke="rgba(255,255,255,.55)" stroke-width="1" />
            </svg>
          </button>
        </div>

        <input
          ref="flexInputRef"
          type="color"
          class="cf-flex-input"
          tabindex="-1"
          aria-hidden="true"
          @change="onFlexInput"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.cf-root {
  display: inline-flex;
  align-items: center;
}
.cf-trigger {
  border-radius: 50%;
  border: 1px solid var(--ui-border-strong);
  box-shadow: var(--ui-shadow-sm);
  cursor: pointer;
  padding: 0;
  flex: none;
  transition: transform var(--ui-duration), box-shadow var(--ui-duration);
}
.cf-trigger:hover,
.cf-trigger.is-open {
  transform: scale(1.08);
  box-shadow: var(--ui-shadow-md);
}
.cf-trigger:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 2px;
}
/* "No color" state: the standard color — an outlined circle with a slash */
.cf-trigger--empty {
  background:
    linear-gradient(to top right, transparent 46%, var(--ui-border-strong) 46%, var(--ui-border-strong) 54%, transparent 54%),
    var(--ui-surface-2);
}
.cf-panel {
  z-index: 50000;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-md);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cf-grid {
  display: grid;
  grid-template-columns: repeat(8, 18px);
  gap: 4px;
}
.cf-panel--sm .cf-grid {
  grid-template-columns: repeat(8, 16px);
  gap: 3px;
}
.cf-swatch {
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  padding: 0;
  cursor: pointer;
  transition: transform var(--ui-duration), box-shadow var(--ui-duration);
}
.cf-panel--sm .cf-swatch {
  width: 16px;
  height: 16px;
}
.cf-swatch:hover {
  transform: scale(1.18);
  box-shadow: var(--ui-shadow-md);
  z-index: 1;
}
.cf-swatch.is-selected {
  outline: 2px solid var(--ui-accent);
  outline-offset: 1px;
}
.cf-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid var(--ui-border);
  padding-top: 8px;
}
.cf-clear {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-2);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.cf-clear:hover {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}
.cf-clear-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--ui-border-strong);
  background:
    linear-gradient(to top right, transparent 44%, var(--ui-border-strong) 44%, var(--ui-border-strong) 56%, transparent 56%),
    var(--ui-surface-2);
}
.cf-flex {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface-2);
  cursor: pointer;
  color: var(--ui-text-2);
}
.cf-flex:hover {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}
.cf-flex-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>