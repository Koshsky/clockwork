<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { t } from '../../../i18n'
import type { CopyFieldProps } from './types'

const props = withDefaults(defineProps<CopyFieldProps>(), {
  label: '',
  monospace: true,
  copyLabel: '',
})

/** Button text: an explicit label wins, otherwise the localized default. */
const copyText = computed(() => props.copyLabel || t('common.copy'))

const copied = ref(false)
const fieldRef = ref<HTMLElement | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function flashCopied() {
  copied.value = true
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = false
  }, 1500)
}

function selectText() {
  const el = fieldRef.value
  if (!el) return
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

async function onCopy() {
  if (!props.value) return
  try {
    await navigator.clipboard.writeText(props.value)
    flashCopied()
  } catch {
    // Clipboard unavailable — select the text for manual copying.
    selectText()
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div class="cf">
    <label v-if="label" class="cf-label">{{ label }}</label>
    <div ref="fieldRef" class="cf-field" :class="{ 'cf-field--mono': monospace }" @click="selectText">
      <span class="cf-value">{{ value || '—' }}</span>
      <button
        type="button"
        class="cf-copy"
        :class="{ 'cf-copy--done': copied }"
        :disabled="!value"
        :aria-label="copied ? t('common.copied') : copyText"
        :title="copied ? t('common.copied') : copyText"
        @click.stop="onCopy"
      >
        <svg
          v-if="!copied"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
@import '../../../styles/tokens.css';

.cf {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cf-label {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-text-2);
}
.cf-field {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--ui-surface-2);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  padding: 9px 8px 9px 12px;
  cursor: text;
  user-select: all;
  min-width: 0;
}
.cf-value {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ui-accent);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
}
.cf-field--mono .cf-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}
.cf-copy {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ui-border-strong);
  background: var(--ui-surface);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-text-muted);
  cursor: pointer;
  transition: color var(--ui-duration), background var(--ui-duration), border-color var(--ui-duration);
}
.cf-copy:hover:not(:disabled) {
  color: var(--ui-accent);
  background: var(--ui-surface-3);
}
.cf-copy:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.cf-copy--done {
  color: var(--ui-success);
  border-color: var(--ui-success-soft);
  background: var(--ui-success-soft);
}
</style>
