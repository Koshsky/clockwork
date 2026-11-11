import { computed, type ComputedRef } from 'vue'
import { pendingRefs, type MutationEntity } from '@/offline/outbox'

/**
 * Reactive "awaiting sync" mark for a list row: true while the object has at
 * least one unsent mutation in the offline queue. The mark key is
 * `${entity}:${id}` — it is maintained by the outbox refreshPendingCount().
 */
export function usePendingMark(entity: MutationEntity, id: number | undefined): ComputedRef<boolean> {
  return computed(() => id != null && pendingRefs.value.has(`${entity}:${id}`))
}