<script setup lang="ts">
import { computed } from 'vue'
import type { PasswordRule } from '../../../composables/usePasswordValidation'
import { validatePassword, passwordRuleText } from '../../../composables/usePasswordValidation'

const props = withDefaults(
  defineProps<{
    modelValue?: string
    rules?: PasswordRule[]
    /** Show rules as "all met" before any input */
    showIdle?: boolean
  }>(),
  {
    modelValue: '',
    rules: () => [],
    showIdle: true,
  },
)

/** Whether each rule is met for the current value */
const status = computed<{ rule: PasswordRule; ok: boolean }[]>(() =>
  props.rules.map((rule) => ({ rule, ok: rule.test(props.modelValue ?? '') })),
)

const allOk = computed(() => validatePassword(props.modelValue ?? '', props.rules))
</script>

<template>
  <ul v-if="rules.length" class="pwr" :class="{ ok: allOk && showIdle }">
    <li
      v-for="item in status"
      :key="item.rule.id"
      class="pwr-item"
      :class="{ done: item.ok || (allOk && showIdle) }"
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class="pwr-mark"
      >
        <path d="M3 8.5 6.5 12 13 4" />
      </svg>
      <span>{{ passwordRuleText(item.rule) }}</span>
    </li>
  </ul>
</template>

<style scoped>
@import '../../../styles/tokens.css';

.pwr {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--ui-text-faint);
}

.pwr-item {
  display: flex;
  align-items: center;
  gap: 7px;
  transition: color var(--ui-duration);
}

.pwr-item.done {
  color: var(--ui-success);
}

.pwr-mark {
  flex: none;
  opacity: 0.5;
}

.pwr-item.done .pwr-mark {
  opacity: 1;
}
</style>
