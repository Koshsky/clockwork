import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({
  disk: vi.fn(), send: vi.fn(), overlay: vi.fn(),
}))
vi.mock('./context', () => ({ platformCapabilities: { kind: 'web', optionalStorage: true, offlineBootstrap: false } }))
vi.mock('@/offline/db', () => ({ idbAll: fake.disk, idbCount: fake.disk, idbGet: fake.disk, idbPut: fake.disk, idbDel: fake.disk, idbClear: fake.disk, idbKeys: fake.disk, IDMAP_STORE_NAME: 'idmap' }))
vi.mock('@/offline/cacheApply', () => ({ applyToCache: fake.overlay }))
vi.mock('axios', () => ({ default: fake.send }))
import { appLocale, setAppLocale } from '@/i18n'
import { nextTick } from 'vue'
import { legacyQueueAvailability } from './state'
import { detectCapabilities, platformPageAvailable } from './capabilities'
import { optionalCacheClear, optionalCacheGet, optionalCacheKeys, optionalCachePut } from './cacheStore'
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from '@/offline/session'
import { clearOutbox, discardEntry, discardFailed, enqueueMutation, flushOutbox, getFailedEntries, pruneForeignOutbox, refreshPendingCount, refreshQueue, replayOutboxToCache, resetFailedRetries, scheduleReplayOutboxToCache } from '@/offline/outbox'

beforeEach(async () => {
  vi.clearAllMocks()
  fake.disk.mockRejectedValue(new Error('Legacy IndexedDB must not be accessed'))
  legacyQueueAvailability.value = 'pending'
  await optionalCacheClear('cache')
})
afterEach(() => vi.unstubAllGlobals())

it('does not discover a legacy queue, including quarantined items and another account', async () => {
  await refreshPendingCount(); await refreshQueue()
  expect(await getFailedEntries()).toEqual([])
  expect(legacyQueueAvailability.value).toBe('pending')
  expect(fake.disk).not.toHaveBeenCalled()
})
it('cannot enqueue or acknowledge a new web offline mutation', async () => {
  await expect(enqueueMutation({ entity: 'task', method: 'POST', url: '/task', body: { title: 'Must remain unsaved' } })).rejects.toThrow('WEB_OFFLINE_QUEUE_UNAVAILABLE')
  expect(fake.disk).not.toHaveBeenCalled(); expect(fake.overlay).not.toHaveBeenCalled()
})
it('cannot send or overlay an old queue through the retired web sender', async () => {
  const result = await flushOutbox()
  await replayOutboxToCache(); scheduleReplayOutboxToCache(); await Promise.resolve()
  expect(result).toMatchObject({ ok: 0, failed: 0, interrupted: false })
  expect(fake.disk).not.toHaveBeenCalled(); expect(fake.send).not.toHaveBeenCalled(); expect(fake.overlay).not.toHaveBeenCalled()
})
it.each([
  ['clear', () => clearOutbox()], ['discard', () => discardEntry('legacy')],
  ['discard failed', () => discardFailed()], ['reset failed', () => resetFailedRetries()],
  ['account switch', () => pruneForeignOutbox('different-account')],
] as const)('does not modify existing IndexedDB during retired web %s', async (_, run) => {
  await run()
  expect(fake.disk).not.toHaveBeenCalled()
  expect(legacyQueueAvailability.value).toBe('pending')
})
it('a language switch does not open the legacy queue', async () => {
  const initial = appLocale.value
  setAppLocale(initial === 'ru' ? 'en' : 'ru'); await nextTick()
  setAppLocale(initial); await nextTick()
  expect(fake.disk).not.toHaveBeenCalled()
})
it('web credentials do not read, rotate or delete an old IndexedDB refresh token', async () => {
  expect(await loadRefreshToken()).toBeNull()
  await saveRefreshToken('not-persisted'); await clearRefreshToken()
  expect(fake.disk).not.toHaveBeenCalled()
})
it('web response cache never opens disk, even with a pending legacy queue and blocked storage', async () => {
  vi.stubGlobal('indexedDB', { get open() { throw new Error('Blocked') } })
  await optionalCachePut('cache', 'u7:/resources', [7])
  expect(await optionalCacheGet('cache', 'u7:/resources')).toEqual([7])
  expect(await optionalCacheGet('cache', 'u8:/resources')).toBeUndefined()
  expect(await optionalCacheKeys('cache')).toEqual(['u7:/resources'])
  await optionalCacheClear('cache')
  expect(await optionalCacheGet('cache', 'u7:/resources')).toBeUndefined()
  expect(fake.disk).not.toHaveBeenCalled()
})
it.each(['system-console', 'system-queue', 'system-status'])('allows %s only on desktop, irrespective of RBAC role', page => {
  expect(platformPageAvailable(page, detectCapabilities(null))).toBe(false)
  expect(platformPageAvailable(page, detectCapabilities({ isElectron: true }))).toBe(true)
})
it('keeps ordinary pages and display settings on both platforms', () => {
  for (const page of ['planner', 'projects', 'processes', 'resources', 'timesheet', 'system-settings', 'profile', undefined]) {
    expect(platformPageAvailable(page, detectCapabilities(null))).toBe(true)
    expect(platformPageAvailable(page, detectCapabilities({ isElectron: true }))).toBe(true)
  }
})
