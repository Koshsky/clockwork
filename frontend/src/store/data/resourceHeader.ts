import { nativeSync } from '@/offline/desktopQueue'
import { TimesheetResourcesApi, type Configuration, type DtoResourceResponse } from '@/api'
import { cacheGet, cachePut, userCachePrefix } from '@/offline/cache'
import { isOffline } from '@/offline/state'
import { pendingRefs } from '@/offline/outbox'
import { mayApplyRead, readStamp } from '@/offline/mutationGuard'
import { platformCapabilities } from '@/platform/context'
import { resourceHeaderRows } from '@/utils/resourceAccess'
import { readApi, isReadCancelled, isReadForbidden, apiReadScope } from './apiReads'
import { ReadCancelled } from '@/data/requestCache'
import { readConfiguration } from './readConfiguration'

export async function loadResourceHeader(configuration: () => Configuration, owner: number | undefined, signal: AbortSignal, force = false): Promise<DtoResourceResponse[] | null> {
  const web = platformCapabilities.kind === 'web'
  const legacy = !web
  const scope = web ? apiReadScope() : ''
  const stamp = readStamp()
  const key = userCachePrefix() + '/local/resource-header?owner_id=' + (owner ?? 'all') + (web && !legacy ? '&scope=' + encodeURIComponent(scope) : '')
  const saved = await cacheGet<DtoResourceResponse[]>(key)
  if (signal.aborted) return null
  if (nativeSync) return saved
  if (web && scope !== apiReadScope()) throw new ReadCancelled()
  if ((isOffline.value && legacy) || pendingRefs.value.size > 0) return saved
  try {
    const rows: DtoResourceResponse[] = []
    for (let offset = 0; ; offset += 500) {
      const client = new TimesheetResourcesApi(readConfiguration(configuration))
      const response = web
        ? await readApi('resource-header:' + (owner ?? 'all') + ':' + offset, [owner, offset, 500], request => client.resourcesGet(500, owner, offset, request), !force, signal)
        : await client.resourcesGet(500, owner, offset)
      if (signal.aborted || (!web && isOffline.value)) return null
      const page = response.data?.data?.items ?? []
      rows.push(...page)
      if (page.length < 500) break
    }
    if (!mayApplyRead(stamp)) return null
    const complete = owner == null ? rows : resourceHeaderRows(rows, owner)
    const saving = cachePut(key, complete)
    if (legacy) await saving
    else void saving
    return complete
  } catch (error) {
    if (signal.aborted) return null
    if (isReadCancelled(error) || isReadForbidden(error)) throw error
    if (web && (scope !== apiReadScope() || !mayApplyRead(stamp))) throw new ReadCancelled()
    if (saved != null) return saved
    throw error
  }
}
