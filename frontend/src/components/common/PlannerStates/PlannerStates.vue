<script setup lang="ts">
import { t } from '../../../i18n'
import type { PlannerStatesProps } from './types'

withDefaults(defineProps<PlannerStatesProps>(), {
  emptyText: '',
})
</script>

<template>
  <div class="pg">
    <div v-if="loading" class="st">{{ t('ui.states.loading') }}</div>
    <template v-else>
      <p v-if="error" class="pg-error">{{ error }}</p>
      <slot v-if="hasData" />
      <div v-else-if="error" class="st er">{{ error }}</div>
      <div v-else class="st">
        <!-- Empty-state content (e.g. a create-action button); falls back to the text -->
        <slot name="empty">{{ emptyText || t('common.noData') }}</slot>
      </div>
    </template>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.pg {
  background: var(--ui-surface);
  border-radius: 10px;
  padding: 12px;
  box-shadow: var(--ui-shadow-sm);
}
.st {
  text-align: center;
  padding: 30px;
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
}
.pg-error {
  color: var(--ui-danger);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  padding: 8px 4px;
}
.er {
  color: var(--ui-danger);
}
</style>
