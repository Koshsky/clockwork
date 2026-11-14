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
import * as cache from './cacheStore'
import * as session from '@/offline/session'
import * as queue from '@/offline/outbox'
import { webOfflineContract } from '../../tests/contracts/webOffline'

beforeEach(async () => {
  vi.clearAllMocks()
  fake.disk.mockRejectedValue(new Error('Legacy IndexedDB must not be accessed'))
  legacyQueueAvailability.value = 'pending'
  await cache.optionalCacheClear('cache')
})
afterEach(() => {
  expect(fake.disk).not.toHaveBeenCalled()
  expect(fake.send).not.toHaveBeenCalled()
  expect(fake.overlay).not.toHaveBeenCalled()
  expect(legacyQueueAvailability.value).toBe('pending')
  vi.unstubAllGlobals()
})

webOfflineContract('development web composition', { cache, queue })
it('web credentials never read, rotate or delete legacy tokens or browser markers', async () => {
  const browserStorage = vi.fn(() => { throw new Error('Browser storage unavailable') })
  vi.stubGlobal('localStorage', { getItem: browserStorage, setItem: browserStorage, removeItem: browserStorage })
  expect(await session.loadRefreshToken()).toBeNull()
  await session.saveRefreshToken('not-persisted'); await session.clearRefreshToken()
  expect(await session.loadRefreshToken()).toBeNull()
  expect(browserStorage).not.toHaveBeenCalled()
})
it('a language switch does not open the legacy queue', async () => {
  const initial = appLocale.value
  setAppLocale(initial === 'ru' ? 'en' : 'ru'); await nextTick()
  setAppLocale(initial); await nextTick()
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
