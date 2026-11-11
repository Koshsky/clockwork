<script setup lang="ts">
import { reactive, watch, computed } from 'vue'
import type { ModalField, ModalFormProps } from './types'
import ColorField from '../ColorField/ColorField.vue'
import { useModalFocus } from '../../../composables/useModalFocus'
import { t } from '../../../i18n'

const props = withDefaults(defineProps<ModalFormProps>(), {
  submitLabel: '',
  busy: false,
  fields: () => [],
  maxWidth: undefined,
})

const emit = defineEmits<{
  save: [values: Record<string, string | number>]
  close: []
}>()

/** Local form state; initialized from fields on open */
const values = reactive<Record<string, string | number>>({})

/**
 * Focus management: initial focus, Tab trap, Escape from anywhere and focus
 * restore to the trigger. Escape previously lived on the overlay's @keydown,
 * which never fired because Teleport moves the markup to <body> while focus
 * stayed behind on the trigger.
 */
const { dialogEl, onKeydown } = useModalFocus({
  open: () => props.open,
  onClose: requestClose,
})

function resetValues() {
  for (const key of Object.keys(values)) delete values[key]
  for (const f of props.fields) {
    values[f.key] = f.value ?? ''
  }
}

/** Text of a display field — a static value, or a getter recomputed live from
 *  the form values (reads `values` reactively, so it re-renders on edit). */
function displayText(f: ModalField): string {
  return f.displayValue ? f.displayValue(values) : String(f.value ?? '')
}

watch(
  () => props.open,
  (open) => {
    if (open) resetValues()
  },
)

const canSubmit = computed(() => {
  if (props.busy) return false
  return props.fields.every((f) => !f.required || String(values[f.key] ?? '').trim() !== '')
})

function onSubmit() {
  if (!canSubmit.value) return
  emit('save', { ...values })
}

function requestClose() {
  if (!props.closeDisabled) emit('close')
}

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) requestClose()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="mf-overlay"
      @mousedown.self="onOverlayClick"
    >
      <div ref="dialogEl" class="mf" :class="dialogClass" :style="maxWidth ? { maxWidth } : undefined" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="onKeydown">
        <div class="mf-head">
          <h3 class="mf-title">{{ title }}</h3>
          <button type="button" class="mf-close" :disabled="closeDisabled" :aria-label="t('common.close')" @click="requestClose">×</button>
        </div>

        <slot v-if="$slots.default" />

        <form v-else class="mf-form" @submit.prevent="onSubmit">
          <!-- A label is invalid around an interactive color trigger: the color
               field renders as a plain div, everything else keeps <label>; a
               display field is pure text (no label, no control). -->
          <component :is="f.type === 'color' || f.type === 'display' ? 'div' : 'label'" v-for="f in fields" :key="f.key" class="mf-field">
            <span v-if="f.type !== 'display'" class="mf-label">
              {{ f.label }}
              <span v-if="f.required" class="mf-req">*</span>
            </span>
            <ColorField
              v-if="f.type === 'color'"
              :model-value="values[f.key] as string"
              :label="f.label"
              @update:model-value="values[f.key] = $event"
            />
            <span
              v-else-if="f.type === 'display'"
              class="mf-display"
            >{{ displayText(f) }}</span>
            <textarea
              v-else-if="f.type === 'textarea'"
              v-model="values[f.key]"
              class="mf-input mf-textarea"
              rows="3"
              :placeholder="f.placeholder"
            />
            <select
              v-else-if="f.type === 'select'"
              v-model="values[f.key]"
              class="mf-input mf-select"
            >
              <option
                v-for="opt in f.options"
                :key="opt.value"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <input
              v-else-if="f.type === 'date'"
              v-model="values[f.key]"
              class="mf-input"
              type="date"
              :readonly="f.readonly"
              :placeholder="f.placeholder"
            />
            <input
              v-else-if="f.type === 'number'"
              v-model.number="values[f.key]"
              class="mf-input"
              type="number"
              min="1"
              :readonly="f.readonly"
              :placeholder="f.placeholder"
            />
            <input
              v-else
              v-model="values[f.key]"
              class="mf-input"
              type="text"
              :placeholder="f.placeholder"
            />
          </component>

          <p v-if="error" class="mf-error" role="alert">{{ error }}</p>

          <div class="mf-actions">
            <button type="button" class="mf-btn mf-cancel" @click="requestClose">{{ t('common.cancel') }}</button>
            <button type="submit" class="mf-btn mf-save" :disabled="!canSubmit">
              <span v-if="busy" class="mf-spinner" />
              {{ submitLabel || t('common.save') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.mf-overlay {
  position: fixed;
  inset: 0;
  z-index: 40000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  padding: 16px;
}
.mf {
  width: 100%;
  max-width: 420px;
  background: var(--ui-surface);
  border-radius: 10px;
  box-shadow: var(--ui-shadow-md);
  overflow: hidden;
}
.mf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ui-border);
}
.mf-title {
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0;
}
.mf-close {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 22px);
  line-height: 1;
  color: var(--ui-text-muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.mf-close:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mf-close:hover:not(:disabled) {
  background: var(--ui-surface-2);
  color: var(--ui-text);
}
.mf-form {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mf-label {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-2);
  font-weight: 500;
}
/* Display-only field: a plain line of text instead of an input control. */
.mf-display {
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  color: var(--ui-text);
  line-height: 1.4;
}
.mf-req {
  color: var(--ui-danger);
}
.mf-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 9px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.mf-input:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.mf-textarea {
  resize: vertical;
  min-height: 70px;
}
.mf-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 2px;
}
.mf-error {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 500;
  color: var(--ui-danger);
}
.mf-btn {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration), opacity var(--ui-duration);
}
.mf-cancel {
  background: var(--ui-surface-2);
  color: var(--ui-text-2);
}
.mf-cancel:hover {
  background: var(--ui-border);
}
.mf-save {
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mf-save:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.mf-save:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.mf-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: var(--ui-accent-on);
  border-radius: 50%;
  animation: mf-spin 0.7s linear infinite;
}
@keyframes mf-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
