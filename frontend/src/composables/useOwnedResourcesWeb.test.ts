import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { DtoResourceResponse } from '@/api'
const fake = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/store', () => ({ apiConfig: () => ({}) }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'web' } }))
vi.mock('@/store/data/resourceHeader', () => ({ loadResourceHeader: fake.load }))
vi.mock('@/store/data/apiReads', () => ({ isReadForbidden: () => false }))
import { useOwnedResources } from './useOwnedResources'
import { pendingRefs } from '@/offline/outbox'
import { refreshActiveReads, resumeActiveReads, stopActiveReads } from '@/data/activeReads'
let scope: ReturnType<typeof effectScope>
beforeEach(() => { vi.resetAllMocks(); resumeActiveReads(); pendingRefs.value = new Set(); scope = effectScope() })
afterEach(() => { scope.stop(); stopActiveReads() })
it('does not reintroduce an inaccessible positive-id resource from a stale table page', async () => {
  fake.load.mockResolvedValue([{ id: 1, owner_id: 7 }])
  const resources = ref<DtoResourceResponse[]>([{ id: 1, owner_id: 7 }, { id: 2, owner_id: 7 }])
  const result = scope.run(() => useOwnedResources(resources, ref(7), ref(true)))!
  await vi.waitFor(() => expect(result.value.map(row => row.id)).toEqual([1]))
})
it('keeps temporary and queued local resources above a complete API roster', async () => {
  fake.load.mockResolvedValue([{ id: 1, owner_id: 7 }]); pendingRefs.value = new Set(['resource:2'])
  const resources = ref<DtoResourceResponse[]>([{ id: 1, owner_id: 7 }, { id: 2, owner_id: 7 }, { id: -3, owner_id: 7 }])
  const result = scope.run(() => useOwnedResources(resources, ref(7), ref(true)))!
  await vi.waitFor(() => expect(result.value.map(row => row.id)).toEqual([1, 2, -3]))
})
it('registers a minute refresh and releases it with the component scope', async () => {
  fake.load.mockResolvedValue([{ id: 1, owner_id: 7 }])
  scope.run(() => useOwnedResources(ref([]), ref(7), ref(true)))
  await nextTick(); await refreshActiveReads()
  expect(fake.load.mock.calls[fake.load.mock.calls.length - 1]?.[3]).toBe(true)
  const count = fake.load.mock.calls.length
  scope.stop(); await refreshActiveReads()
  expect(fake.load).toHaveBeenCalledTimes(count)
})
