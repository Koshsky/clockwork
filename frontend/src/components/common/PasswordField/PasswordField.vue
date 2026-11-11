<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../../../i18n'

withDefaults(
  defineProps<{
    modelValue?: string
    label?: string
    placeholder?: string
    autocomplete?: string
    /** Hide the visibility toggle button */
    toggle?: boolean
    /** Common id attribute for the label */
    id?: string
  }>(),
  {
    modelValue: '',
    label: '',
    placeholder: '••••••••',
    autocomplete: 'new-password',
    toggle: true,
    id: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const visible = ref(false)

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function toggleVisibility() {
  visible.value = !visible.value
}
</script>

<template>
  <div class="pwf">
    <label v-if="label" class="pwf-label" :for="id">{{ label }}</label>
    <div class="pwf-input-wrap">
      <input
        :id="id"
        :value="modelValue"
        :type="visible ? 'text' : 'password'"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        class="pwf-input"
        @input="onInput"
      />
      <button v-if="toggle" type="button" class="pwf-eye" :aria-label="visible ? t('ui.password.hide') : t('ui.password.show')" @click="toggleVisibility">
        <svg
          v-if="visible"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 3l18 18" />
          <path d="M10.6 5.1A8.8 8.8 0 0 1 12 5c5.5 0 9 6 9 6a15.4 15.4 0 0 1-3 3.6M6.6 6.6A15 15 0 0 0 3 11s3.5 6 9 6a8.9 8.9 0 0 0 2.6-.4" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
@import '../../../styles/tokens.css';

.pwf {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-text-2);
}

.pwf-label {
  color: var(--ui-text-2);
}

.pwf-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.pwf-input {
  width: 100%;
  padding: 12px 14px;
  padding-right: 46px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 400;
  color: var(--ui-text);
  background: var(--ui-surface);
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}

.pwf-input::placeholder {
  color: var(--ui-text-faint);
}

.pwf-input:focus {
  outline: none;
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent) 15%, transparent);
}

.pwf-eye {
  position: absolute;
  right: 6px;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--ui-text-muted);
  cursor: pointer;
  border-radius: var(--ui-radius-sm);
  transition: color var(--ui-duration), background var(--ui-duration);
}

.pwf-eye:hover {
  color: var(--ui-accent);
  background: var(--ui-surface-3);
}
</style>
