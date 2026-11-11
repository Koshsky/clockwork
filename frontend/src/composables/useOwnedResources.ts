import { computed, ref, watch, type Ref } from 'vue'
import { TimesheetResourcesApi, type DtoResourceResponse } from '@/api'
import { apiConfig } from '@/store'
import { isOffline } from '@/offline/state'
import { cacheGet, cachePut, userCachePrefix } from '@/offline/cache'
import { mayApplyRead, readStamp } from '@/offline/mutationGuard'
import { pendingRefs } from '@/offline/outbox'
import { resourceHeaderRows } from '@/utils/resourceAccess'

/** The planning header must not inherit the resource table's pagination. */
export function useOwnedResources(resources: Ref<DtoResourceResponse[]>, userId: Ref<number | undefined>, enabled: Ref<boolean>, allOwners: Ref<boolean> = ref(false)) {
  const loaded = ref<DtoResourceResponse[] | null>(null)
  let request = 0
  watch([resources, userId, enabled, allOwners, isOffline, pendingRefs], async () => {
    const generation = ++request
    loaded.value = null
    if (!enabled.value || userId.value == null) return
    const owner = allOwners.value ? undefined : userId.value
    const key = userCachePrefix() + '/local/resource-header?owner_id=' + (allOwners.value ? 'all' : owner)
    const saved = await cacheGet<DtoResourceResponse[]>(key)
    if (generation !== request) return
    loaded.value = saved
    if (isOffline.value || pendingRefs.value.size > 0) return
    const stamp = readStamp()
    try {
      const rows: DtoResourceResponse[] = []
      for (let offset = 0; ; offset += 500) {
        const response = await new TimesheetResourcesApi(apiConfig()).resourcesGet(500, owner, offset)
        if (isOffline.value || generation !== request) return
        const page = response.data?.data?.items ?? []
        rows.push(...page)
        if (page.length < 500) break
      }
      if (generation !== request || !mayApplyRead(stamp)) return
      loaded.value = allOwners.value ? rows : resourceHeaderRows(rows, owner)
      await cachePut(key, loaded.value)
    } catch {
      // Retain the last complete scope snapshot when the backend is unavailable.
    }
  }, { immediate: true, deep: true })
  return computed(() => {
    const rows = new Map((loaded.value ?? []).map((row) => [row.id, row]))
    for (const row of resources.value) rows.set(row.id, row)
    return allOwners.value ? [...rows.values()] : resourceHeaderRows([...rows.values()], userId.value)
  })
}
