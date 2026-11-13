import { createCacheApplier } from '@/domain/cacheProjection'
import type { OutboxEntry } from './outbox'
import { idbGet, idbKeys, idbPut } from './db'
import { currentUserId, keyMatchesUser } from './cache'

const cache = createCacheApplier({
  keys: async () => (await idbKeys('cache')).filter(key => keyMatchesUser(key, currentUserId())),
  get: key => idbGet('cache', key),
  put: (key, value) => idbPut('cache', key, value),
})
export async function applyToCache(entry: OutboxEntry): Promise<void> {
  try { await cache.applyToCache(entry) } catch { /* Legacy storage cannot acknowledge the projection atomically. */ }
}
