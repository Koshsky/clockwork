import { computed, type ComputedRef } from 'vue'
import { pendingRefs, type MutationEntity } from '@/store/data/uiServices'
import { webPendingRefs } from '@/store/data/webCommands'

/** Both transports keep the pending mark visible until their own confirmation. */
export function usePendingMark(entity: MutationEntity, id: number | undefined): ComputedRef<boolean> {
  return computed(() => id != null && (pendingRefs.value.has(`${entity}:${id}`) || webPendingRefs.value.has(`${entity}:${id}`)))
}
