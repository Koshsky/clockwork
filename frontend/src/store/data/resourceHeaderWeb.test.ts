import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError, type AxiosResponse } from 'axios'
import { beginMutation } from '@/offline/mutationGuard'
const fake = vi.hoisted(() => ({ get: vi.fn(), saved: vi.fn(), put: vi.fn() }))
vi.mock('@/api', async original => ({ ...await original<typeof import('@/api')>(), TimesheetResourcesApi: class { resourcesGet(...args: unknown[]) { return fake.get(...args) } } }))
vi.mock('@/config', () => ({ getApiUrl: () => '/api/v1' }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'web', optionalStorage: true } }))
vi.mock('@/offline/cache', () => ({ currentUserId: () => 7, userCachePrefix: () => 'u7:', cacheGet: fake.saved, cachePut: fake.put }))
import { Configuration } from '@/api'
import { loadResourceHeader } from './resourceHeader'
import { invalidateApiReads } from './apiReads'
import { isOffline } from '@/offline/state'
import { legacyQueueAvailability } from '@/platform/state'
import { pendingRefs } from '@/offline/outbox'
const configuration = () => new Configuration({ basePath: '/api/v1' })
const response = (items: unknown[]) => ({ data: { data: { items } } })
beforeEach(() => {
  vi.resetAllMocks(); invalidateApiReads(); fake.saved.mockResolvedValue(null); fake.put.mockResolvedValue(undefined)
  isOffline.value = false; legacyQueueAvailability.value = 'empty'; pendingRefs.value = new Set()
})
afterEach(invalidateApiReads)
describe('complete API resource-header adapter', () => {
  it('reads all 1001 resources and never applies the table limit to the header', async () => {
    fake.get.mockImplementation(async (_limit, owner, offset) => response(Array.from({ length: Math.min(500, 1001 - offset) }, (_, n) => ({ id: offset + n + 1, owner_id: owner }))))
    const rows = await loadResourceHeader(configuration, 7, new AbortController().signal)
    expect(rows).toHaveLength(1001)
    expect(fake.get.mock.calls.map(args => args.slice(0, 3))).toEqual([[500, 7, 0], [500, 7, 500], [500, 7, 1000]])
  })
  it('requests all owners for the administrator without impersonating planning', async () => {
    fake.get.mockResolvedValue(response([{ id: 1, owner_id: 7 }, { id: 2, owner_id: 8 }]))
    expect(await loadResourceHeader(configuration, undefined, new AbortController().signal)).toHaveLength(2)
    expect(fake.get.mock.calls[0].slice(0, 3)).toEqual([500, undefined, 0])
    expect(fake.get.mock.calls[0][3].headers).toBeUndefined()
  })
  it('keeps only owned resources for a non-administrator', async () => {
    fake.get.mockResolvedValue(response([{ id: 1, owner_id: 7 }, { id: 2, owner_id: 8 }]))
    expect(await loadResourceHeader(configuration, 7, new AbortController().signal)).toEqual([{ id: 1, owner_id: 7 }])
  })
  it('returns an empty complete roster as success', async () => {
    fake.get.mockResolvedValue(response([]))
    expect(await loadResourceHeader(configuration, 7, new AbortController().signal)).toEqual([])
    expect(fake.put).toHaveBeenCalledWith(expect.stringMatching(/^u7:\/local\/resource-header\?owner_id=7&scope=/), [])
  })
  it('does not wait for optional legacy persistence before returning API data', async () => {
    fake.get.mockResolvedValue(response([{ id: 1, owner_id: 7 }]))
    fake.put.mockReturnValue(new Promise(() => {}))
    expect(await loadResourceHeader(configuration, 7, new AbortController().signal)).toHaveLength(1)
  })
  it('does not publish an incomplete first page after a later page fails', async () => {
    fake.get.mockResolvedValueOnce(response(Array.from({ length: 500 }, (_, id) => ({ id, owner_id: 7 })))).mockRejectedValueOnce(new Error('page two failed'))
    await expect(loadResourceHeader(configuration, 7, new AbortController().signal)).rejects.toThrow('page two failed')
    expect(fake.put).not.toHaveBeenCalled()
  })
  it('retains a complete same-owner snapshot on network failure', async () => {
    fake.saved.mockResolvedValue([{ id: 8, owner_id: 7 }]); fake.get.mockRejectedValue(new Error('network'))
    expect(await loadResourceHeader(configuration, 7, new AbortController().signal)).toEqual([{ id: 8, owner_id: 7 }])
  })
  it('does not return a saved roster after access is forbidden', async () => {
    fake.saved.mockResolvedValue([{ id: 8, owner_id: 7 }])
    fake.get.mockRejectedValue(new AxiosError('Forbidden', undefined, undefined, undefined, { status: 403 } as AxiosResponse))
    await expect(loadResourceHeader(configuration, 7, new AbortController().signal)).rejects.toThrow('Forbidden')
  })
  it('cancels an abandoned header request without storing partial rows', async () => {
    fake.get.mockReturnValue(new Promise(() => {}))
    const abort = new AbortController(), pending = loadResourceHeader(configuration, 7, abort.signal)
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalledOnce())
    abort.abort()
    expect(await pending).toBeNull(); expect(fake.put).not.toHaveBeenCalled()
  })
  it('does not publish a response crossing an optimistic mutation', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    fake.get.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = loadResourceHeader(configuration, 7, new AbortController().signal)
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalledOnce())
    const end = beginMutation(); finish(response([{ id: 1, owner_id: 7 }]))
    try { await expect(pending).rejects.toThrow('Read superseded') } finally { end() }
    expect(fake.put).not.toHaveBeenCalled()
  })
  it('does not fall back to a saved roster when a policy reset cancels the read', async () => {
    fake.saved.mockResolvedValue([{ id: 8, owner_id: 7 }])
    fake.get.mockReturnValue(new Promise(() => {}))
    const pending = loadResourceHeader(configuration, 7, new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('Read superseded')
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalledOnce())
    invalidateApiReads()
    await rejected
    expect(fake.put).not.toHaveBeenCalled()
  })
  it('isolates complete roster snapshots across permission revisions', async () => {
    fake.get.mockResolvedValue(response([{ id: 1, owner_id: 7 }]))
    await loadResourceHeader(configuration, 7, new AbortController().signal)
    const first = fake.put.mock.calls[0][0]
    invalidateApiReads()
    await loadResourceHeader(configuration, 7, new AbortController().signal)
    expect(fake.put.mock.calls[1][0]).not.toBe(first)
  })
})
