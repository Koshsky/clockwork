import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { DtoResourceResponse } from '@/api'
import { isOffline } from '@/offline/state'
import { pendingRefs } from '@/offline/outbox'
const calls = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn(), write: vi.fn() }))
vi.mock('@/api', () => ({ TimesheetResourcesApi: class { resourcesGet(...args: unknown[]) { return calls.get(...args) } } }))
vi.mock('@/offline/outbox', async () => { const { ref } = await import('vue'); return { pendingRefs: ref(new Set()) } })
vi.mock('@/store', () => ({ apiConfig: () => ({}) }))
vi.mock('@/offline/cache', () => ({ cacheGet: calls.read, cachePut: calls.write, userCachePrefix: () => 'u7:' }))
import { useOwnedResources } from './useOwnedResources'
let scope: ReturnType<typeof effectScope>
beforeEach(() => { vi.clearAllMocks(); calls.read.mockResolvedValue(null); pendingRefs.value = new Set(); isOffline.value = false; scope = effectScope() })
afterEach(() => { scope.stop(); isOffline.value = false })
describe('complete owner-only resource header', () => {
  it('loads 501 owned resources across pages independently of the table and excludes foreign rows', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, owner_id: 7 }))
    calls.get.mockResolvedValueOnce({ data: { data: { items: first } } }).mockResolvedValueOnce({ data: { data: { items: [{ id: 501, owner_id: 7 }, { id: 502, owner_id: 8 }] } } })
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([{ id: 1, owner_id: 7 }]), ref(7), ref(true)))!
    await vi.waitFor(() => expect(result.value).toHaveLength(501))
    expect(calls.get.mock.calls.map((args) => args.slice(0, 3))).toEqual([[500, 7, 0], [500, 7, 500]])
    expect(result.value.every((r) => r.owner_id === 7)).toBe(true)
    expect(calls.write).toHaveBeenCalledTimes(1)
  })
  it('restores the complete cached owner snapshot offline without API reads', async () => {
    isOffline.value = true
    calls.read.mockResolvedValue([{ id: 1, owner_id: 7 }, { id: 2, owner_id: 7 }])
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(true)))!
    await vi.waitFor(() => expect(result.value).toHaveLength(2))
    expect(calls.get).not.toHaveBeenCalled()
  })
  it('does not fetch when resource loading is disabled', async () => {
    scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(false)))
    await Promise.resolve()
    expect(calls.get).not.toHaveBeenCalled()
    expect(calls.read).not.toHaveBeenCalled()
  })
})


describe('administrator whole-system resource header', () => {
  it('loads all owners across pages without sending an owner filter', async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, owner_id: i % 2 ? 8 : 9 }))
    calls.get.mockResolvedValueOnce({ data: { data: { items: first } } }).mockResolvedValueOnce({ data: { data: { items: [{ id: 501 }] } } })
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(true), ref(true)))!
    await vi.waitFor(() => expect(result.value).toHaveLength(501))
    expect(calls.get.mock.calls.map(args => args.slice(0, 3))).toEqual([[500, undefined, 0], [500, undefined, 500]])
    expect(calls.write).toHaveBeenCalledWith('u7:/local/resource-header?owner_id=all', result.value)
  })

  it('caches an empty complete system without inventing resource rows', async () => {
    calls.get.mockResolvedValue({ data: { data: { items: [] } } })
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(true), ref(true)))!
    await vi.waitFor(() => expect(calls.write).toHaveBeenCalled())
    expect(result.value).toEqual([])
    expect(calls.get).toHaveBeenCalledExactlyOnceWith(500, undefined, 0)
  })

  it('restores all owners offline and merges local resource changes by id', async () => {
    isOffline.value = true
    calls.read.mockResolvedValue([{ id: 1, owner_id: 8, code: 'old' }, { id: 2, owner_id: 9 }])
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([{ id: 1, owner_id: 8, code: 'edited' }, { id: -1000000, owner_id: 10 }]), ref(7), ref(true), ref(true)))!
    await vi.waitFor(() => expect(result.value).toHaveLength(3))
    expect(result.value.find(row => row.id === 1)?.code).toBe('edited')
    expect(calls.read).toHaveBeenCalledWith('u7:/local/resource-header?owner_id=all')
    expect(calls.get).not.toHaveBeenCalled()
  })

  it('keeps queued changes while restoring the last complete system snapshot', async () => {
    pendingRefs.value = new Set(['resource:1'])
    calls.read.mockResolvedValue([{ id: 1, owner_id: 8 }, { id: 2, owner_id: 9 }])
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(true), ref(true)))!
    await vi.waitFor(() => expect(result.value).toHaveLength(2))
    expect(calls.get).not.toHaveBeenCalled()
  })

  it('cannot reuse an all-owner snapshot after returning to an owner-only view', async () => {
    isOffline.value = true
    calls.read.mockImplementation(async key => key.endsWith('=all') ? [{ id: 1, owner_id: 8 }, { id: 2, owner_id: 7 }] : [{ id: 2, owner_id: 7 }])
    const all = ref(true)
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(true), all))!
    await vi.waitFor(() => expect(result.value).toHaveLength(2))
    all.value = false
    await vi.waitFor(() => expect(result.value).toEqual([{ id: 2, owner_id: 7 }]))
    expect(calls.read).toHaveBeenLastCalledWith('u7:/local/resource-header?owner_id=7')
  })

  it('ignores a late full-system response after the owner scope changes', async () => {
    let complete!: (value: unknown) => void
    calls.get.mockImplementation((_limit, owner) => owner == null
      ? new Promise(resolve => { complete = resolve })
      : Promise.resolve({ data: { data: { items: [{ id: 2, owner_id: 7 }] } } }))
    const all = ref(true)
    const result = scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref(7), ref(true), all))!
    await vi.waitFor(() => expect(complete).toBeDefined())
    all.value = false
    await vi.waitFor(() => expect(result.value).toEqual([{ id: 2, owner_id: 7 }]))
    complete({ data: { data: { items: [{ id: 1, owner_id: 8 }] } } })
    await Promise.resolve()
    expect(result.value).toEqual([{ id: 2, owner_id: 7 }])
    expect(calls.write).not.toHaveBeenCalledWith('u7:/local/resource-header?owner_id=all', expect.anything())
  })

  it('does not load a full-system snapshot without an account identity', async () => {
    scope.run(() => useOwnedResources(ref<DtoResourceResponse[]>([]), ref<number | undefined>(undefined), ref(true), ref(true)))
    await Promise.resolve()
    expect(calls.get).not.toHaveBeenCalled()
    expect(calls.read).not.toHaveBeenCalled()
  })
})
