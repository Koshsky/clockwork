import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { DtoResourceResponse } from '@/api'

const fake = vi.hoisted(() => ({ load: vi.fn(), scope: { value: 'initial' }, denial: new Error('Forbidden') }))
vi.mock('@/store', () => ({ apiConfig: () => ({}) }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop' } }))
vi.mock('@/store/data/resourceHeader', () => ({ loadResourceHeader: fake.load }))
vi.mock('@/store/data/apiReads', () => ({ apiReadScope: () => fake.scope.value, isReadForbidden: (error: unknown) => error === fake.denial }))
vi.mock('@/store/data/uiServices', async () => { const { ref } = await import('vue'); return { isOffline: ref(false), pendingRefs: ref(new Set()) } })
import { useOwnedResources } from './useOwnedResources'

let scope: ReturnType<typeof effectScope>
beforeEach(() => { vi.resetAllMocks(); fake.scope = ref('server-a/account7/epoch0'); scope = effectScope() })
afterEach(() => scope.stop())
const roster = (count: number, owner = 7) => Array.from({ length: count }, (_, index) => ({ id: index + 1, owner_id: owner, code: 'R' + (index + 1) }))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(rows: DtoResourceResponse[] = roster(50)) {
  const resources = ref<DtoResourceResponse[]>(rows), user = ref<number | undefined>(7), enabled = ref(true), all = ref(true)
  const result = scope.run(() => useOwnedResources(resources, user, enabled, all))!
  return { resources, user, enabled, all, result }
}

describe('complete resource header refresh boundaries', () => {
  it('retains 60 and then 501 complete rows while a table-page refresh is pending', async () => {
    fake.load.mockResolvedValueOnce(roster(60))
    const view = setup()
    await vi.waitFor(() => expect(view.result.value).toHaveLength(60))
    const next = deferred<DtoResourceResponse[]>()
    fake.load.mockReturnValueOnce(next.promise)
    view.resources.value = roster(50)
    await nextTick()
    expect(view.result.value).toHaveLength(60)
    next.resolve(roster(501))
    await vi.waitFor(() => expect(view.result.value).toHaveLength(501))
    fake.load.mockReturnValueOnce(new Promise(() => {}))
    view.resources.value[0]!.code = 'Local edit'
    await nextTick()
    expect(view.result.value).toHaveLength(501)
    expect(view.result.value[0]!.code).toBe('Local edit')
  })

  it('preserves complete same-scope data when a refresh is missing, cancelled or fails offline', async () => {
    fake.load.mockResolvedValueOnce(roster(60))
    const view = setup()
    await vi.waitFor(() => expect(view.result.value).toHaveLength(60))
    for (const outcome of [null, new Error('Cancelled'), new Error('Disconnected')]) {
      if (outcome instanceof Error) fake.load.mockRejectedValueOnce(outcome)
      else fake.load.mockResolvedValueOnce(outcome)
      view.resources.value = roster(50)
      await nextTick(); await Promise.resolve(); await nextTick()
      expect(view.result.value).toHaveLength(60)
    }
  })

  it('clears forbidden rows and does not restore them after a missing retry', async () => {
    fake.load.mockResolvedValueOnce(roster(60))
    const view = setup()
    await vi.waitFor(() => expect(view.result.value).toHaveLength(60))
    fake.load.mockRejectedValueOnce(fake.denial)
    view.resources.value = roster(50)
    await vi.waitFor(() => expect(view.result.value).toEqual([]))
    fake.load.mockResolvedValueOnce(null)
    view.resources.value = roster(50)
    await nextTick(); await Promise.resolve()
    expect(view.result.value).toEqual([])
    fake.load.mockResolvedValueOnce([{ id: 1, owner_id: 7, code: 'Permitted' }])
    view.resources.value[0]!.code = 'Old inaccessible page'
    await vi.waitFor(() => expect(view.result.value).toEqual([{ id: 1, owner_id: 7, code: 'Permitted' }]))
  })

  it('immediately removes old rows on owner, account and enabled changes and rejects late reads', async () => {
    fake.load.mockResolvedValueOnce([...roster(1), { id: 2, owner_id: 8 }])
    const view = setup([])
    await vi.waitFor(() => expect(view.result.value).toHaveLength(2))
    const old = deferred<DtoResourceResponse[]>()
    fake.load.mockReturnValueOnce(old.promise)
    view.resources.value = []
    await nextTick()
    fake.load.mockResolvedValueOnce([{ id: 1, owner_id: 7 }])
    view.all.value = false
    expect(view.result.value).toEqual([])
    await vi.waitFor(() => expect(view.result.value).toEqual([{ id: 1, owner_id: 7 }]))
    old.resolve([{ id: 2, owner_id: 8 }]); await Promise.resolve(); await nextTick()
    expect(view.result.value).toEqual([{ id: 1, owner_id: 7 }])
    fake.load.mockReturnValueOnce(new Promise(() => {}))
    view.user.value = 8
    expect(view.result.value).toEqual([])
    await nextTick()
    view.enabled.value = false
    expect(view.result.value).toEqual([])
  })

  it('binds cached rows and table overlays to the server and permission epoch even when account ids match', async () => {
    fake.load.mockResolvedValueOnce([{ id: 1, owner_id: 7, code: 'Server A' }])
    const view = setup([{ id: 1, owner_id: 7, code: 'Old table A' }])
    await nextTick()
    await vi.waitFor(() => expect(view.result.value[0]?.code).toBe('Old table A'))
    const pending = deferred<DtoResourceResponse[]>()
    fake.load.mockReturnValueOnce(pending.promise)
    fake.scope.value = 'server-b/account7/epoch1'
    expect(view.result.value).toEqual([])
    await nextTick()
    expect(view.result.value).toEqual([])
    pending.resolve([{ id: 1, owner_id: 7, code: 'Server B' }])
    await vi.waitFor(() => expect(view.result.value).toEqual([{ id: 1, owner_id: 7, code: 'Server B' }]))
    fake.load.mockReturnValueOnce(new Promise(() => {}))
    fake.scope.value = 'server-b/account7/epoch2'
    expect(view.result.value).toEqual([])
    await nextTick()
    expect(view.result.value).toEqual([])
  })

  it('accepts a fresh table reference and its pending overlays after a scope boundary without accepting an old response', async () => {
    fake.load.mockResolvedValueOnce([{ id: 1, owner_id: 7, code: 'Old complete' }])
    const view = setup([])
    await vi.waitFor(() => expect(view.result.value).toHaveLength(1))
    const stale = deferred<DtoResourceResponse[]>()
    fake.load.mockReturnValueOnce(stale.promise)
    view.resources.value = roster(50)
    await nextTick()
    fake.load.mockResolvedValueOnce([{ id: 1, owner_id: 7, code: 'New complete' }])
    fake.scope.value = 'server-b/account7/epoch1'
    await vi.waitFor(() => expect(view.result.value).toEqual([{ id: 1, owner_id: 7, code: 'New complete' }]))
    fake.load.mockReturnValueOnce(new Promise(() => {}))
    view.resources.value = [{ id: 1, owner_id: 7, code: 'Fresh local edit' }, { id: -2, owner_id: 7, code: 'Fresh pending create' }]
    await nextTick()
    expect(view.result.value.map(row => row.code)).toEqual(['Fresh local edit', 'Fresh pending create'])
    stale.resolve([{ id: 1, owner_id: 7, code: 'Stale old response' }])
    await Promise.resolve(); await nextTick()
    expect(view.result.value.map(row => row.code)).toEqual(['Fresh local edit', 'Fresh pending create'])
  })
})
