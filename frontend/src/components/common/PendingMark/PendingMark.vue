<script setup lang="ts">
import AppIcon from '../AppIcon/AppIcon.vue'
import { usePendingMark } from '@/composables/usePendingMark'
import type { MutationEntity } from '@/offline/outbox'
import { t } from '../../../i18n'

/**
 * "Awaiting sync" clock mark for a list row: shown while the object has at
 * least one unsent mutation in the offline queue (see usePendingMark).
 * Minimal and unobtrusive — a small warning-colored clock with a tooltip.
 */
const props = withDefaults(
  defineProps<{
    /** Outbox entity kind the row belongs to */
    entity: MutationEntity
    /** Object id (or the temporary id for offline-created rows) */
    id?: number | null
    /** Icon size in px (default 16) */
    size?: number
  }>(),
  { size: 16 },
)

const pending = usePendingMark(props.entity, props.id ?? undefined)
</script>

<template>
  <span v-if="pending" class="pm" :title="t('ui.pending.title')">
    <AppIcon name="clock" :size="size" />
  </span>
</template>

<style scoped>
.pm {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--ui-warning);
  opacity: 0.85;
}
</style>