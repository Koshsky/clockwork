import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Cache from '../../src/platform/cacheStore'
import type * as Queue from '../../src/offline/outbox'

export function webOfflineContract(name: string, api: {
  cache: Pick<typeof Cache, 'optionalCachePut' | 'optionalCacheGet' | 'optionalCacheKeys' | 'optionalCacheClear'>
  queue: Pick<typeof Queue, 'enqueueMutation' | 'flushOutbox' | 'clearOutbox' | 'discardEntry' | 'discardFailed' | 'resetFailedRetries' | 'pruneForeignOutbox' | 'replayOutboxToCache' | 'scheduleReplayOutboxToCache' | 'refreshPendingCount' | 'refreshQueue' | 'getFailedEntries' | 'pendingCount' | 'pendingRefs'>
}) {
  describe(name, () => {
    const disk = vi.fn(() => { throw new Error('Web must not touch legacy persistence') })
    beforeEach(async () => {
      disk.mockClear()
      vi.stubGlobal('indexedDB', { open: disk, databases: disk, deleteDatabase: disk })
      vi.stubGlobal('localStorage', { getItem: disk, setItem: disk, removeItem: disk })
      await api.cache.optionalCacheClear('cache')
    })
    afterEach(() => { expect(disk).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

    it('distinguishes missing and empty snapshots, clones both boundaries and isolates account/server keys', async () => {
      expect(await api.cache.optionalCacheGet('cache', 'missing')).toBeUndefined()
      await api.cache.optionalCachePut('cache', 'empty', [])
      expect(await api.cache.optionalCacheGet('cache', 'empty')).toEqual([])
      const data = { items: [{ id: 1 }] }
      await api.cache.optionalCachePut('cache', 'server-a:u7:/resources', data)
      data.items[0].id = 2
      const read = await api.cache.optionalCacheGet<typeof data>('cache', 'server-a:u7:/resources')
      read!.items[0].id = 3
      expect(await api.cache.optionalCacheGet('cache', 'server-a:u7:/resources')).toEqual({ items: [{ id: 1 }] })
      expect(await api.cache.optionalCacheGet('cache', 'server-b:u7:/resources')).toBeUndefined()
      expect(await api.cache.optionalCacheGet('cache', 'server-a:u8:/resources')).toBeUndefined()
      expect(await api.cache.optionalCacheKeys('cache')).toEqual(['empty', 'server-a:u7:/resources'])
      await api.cache.optionalCacheClear('cache')
      expect(await api.cache.optionalCacheKeys('cache')).toEqual([])
      expect(await api.cache.optionalCacheGet('cache', 'empty')).toBeUndefined()
    })
    it('refuses a new offline write without acknowledging or overlaying it', async () => {
      await expect(api.queue.enqueueMutation({ entity: 'task', method: 'POST', url: '/task', body: { title: 'Unsent' } })).rejects.toThrow('WEB_OFFLINE_QUEUE_UNAVAILABLE')
      expect(api.queue.pendingCount.value).toBe(0)
      expect(api.queue.pendingRefs.value.size).toBe(0)
    })
    it('never discovers, sends, deletes or replays legacy commands through cleanup or retry controls', async () => {
      await api.queue.refreshPendingCount(); await api.queue.refreshQueue()
      await api.queue.clearOutbox(); await api.queue.discardEntry('legacy')
      await api.queue.discardFailed(); await api.queue.resetFailedRetries()
      await api.queue.pruneForeignOutbox('different-account')
      await api.queue.replayOutboxToCache(); api.queue.scheduleReplayOutboxToCache()
      expect(await api.queue.flushOutbox()).toMatchObject({ ok: 0, failed: 0, interrupted: false })
      expect(await api.queue.getFailedEntries()).toEqual([])
    })
  })
}
