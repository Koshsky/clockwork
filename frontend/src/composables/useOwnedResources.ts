import { computed, ref, watch, getCurrentScope, onScopeDispose, type Ref } from 'vue'
import { registerActiveRead } from '@/data/activeReads'
import { platformCapabilities } from '@/platform/context'
import type { DtoResourceResponse } from '@/api'
import { apiConfig } from '@/store'
import { isOffline } from '@/store/data/uiServices'
import { apiReadScope, isReadForbidden } from '@/store/data/apiReads'
import { loadResourceHeader } from '@/store/data/resourceHeader'
import { pendingRefs } from '@/store/data/uiServices'
import { resourceHeaderRows } from '@/utils/resourceAccess'

/** The planning header must not inherit the resource table's pagination. */
export function useOwnedResources(resources: Ref<DtoResourceResponse[]>, userId: Ref<number | undefined>, enabled: Ref<boolean>, allOwners: Ref<boolean> = ref(false)) {
  const loaded = ref<DtoResourceResponse[] | null>(null)
  let request = 0
  const denied = ref(false)
  const contextScope = () => JSON.stringify([apiReadScope(), userId.value, allOwners.value, enabled.value])
  const loadedScope = ref(contextScope())
  const fallbackScope = ref<string | null>(loadedScope.value)
  let pageResources = resources.value
  let controller: AbortController | null = null
  async function refresh(force = false) {
    const generation = ++request
    controller?.abort()
    const scope = contextScope()
    if (loadedScope.value !== scope) {
      loaded.value = null
      loadedScope.value = scope
      denied.value = false
      // A table page loaded before an identity or permission reset is not a fallback for the new scope.
      fallbackScope.value = resources.value !== pageResources ? scope : null
    } else if (resources.value !== pageResources && !denied.value) {
      fallbackScope.value = scope
    }
    pageResources = resources.value
    if (!enabled.value || userId.value == null) return false
    const abort = new AbortController()
    controller = abort
    try {
      const rows = await loadResourceHeader(apiConfig, allOwners.value ? undefined : userId.value, abort.signal, force)
      if (generation === request && !abort.signal.aborted && scope === contextScope() && rows != null) { loaded.value = rows; denied.value = false }
    } catch (error) {
      if (generation === request && scope === contextScope() && isReadForbidden(error)) { loaded.value = null; fallbackScope.value = null; denied.value = true }
      // The table's current resources remain usable if a complete header read fails.
    }
  }
  const stopWatch = watch([resources, userId, enabled, allOwners, isOffline, pendingRefs, apiReadScope], () => void refresh(), { immediate: true, deep: true })
  const stopRefresh = platformCapabilities.kind === 'web' ? registerActiveRead(() => refresh(true)) : () => {}
  if (getCurrentScope()) onScopeDispose(() => { request++; controller?.abort(); stopWatch(); stopRefresh() })
  return computed(() => {
    const scope = contextScope()
    if (!enabled.value || userId.value == null || denied.value || loadedScope.value !== scope) return []
    const rows = new Map((loaded.value ?? []).map((row) => [row.id, row]))
    for (const row of fallbackScope.value === scope ? resources.value : []) {
      const authoritative = platformCapabilities.kind === 'web' && loaded.value != null
      if (authoritative && !rows.has(row.id) && (row.id ?? 0) >= 0 && !pendingRefs.value.has('resource:' + row.id)) continue
      rows.set(row.id, row)
    }
    return allOwners.value ? [...rows.values()] : resourceHeaderRows([...rows.values()], userId.value)
  })
}
