import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ optional: true, put: vi.fn(), get: vi.fn(), keys: vi.fn(), clear: vi.fn(), del: vi.fn() }))
vi.mock('./context', () => ({ platformCapabilities: { get optionalStorage() { return fake.optional } } }))
vi.mock('@/offline/db', () => ({ idbPut: fake.put, idbGet: fake.get, idbKeys: fake.keys, idbClear: fake.clear, idbDel: fake.del }))
import { localDataAvailability } from './state'
import { optionalCachePut, optionalCacheGet, optionalCacheKeys, optionalCacheClear } from './cacheStore'
import { saveRefreshToken, loadRefreshToken, clearRefreshToken } from '@/offline/session'
let values: Map<string, string>
beforeEach(async () => {
  vi.resetAllMocks(); fake.optional = true
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  localDataAvailability.value = 'unavailable'
  await optionalCacheClear('cache')
  localDataAvailability.value = 'unknown'
  fake.keys.mockResolvedValue([])
})
afterEach(() => vi.unstubAllGlobals())
it('uses a cloned disposable cache when web storage is unavailable', async () => {
  localDataAvailability.value = 'unavailable'
  const input = { name: 'original' }
  await optionalCachePut('cache', 'user:1:/projects', input)
  input.name = 'changed'
  const cached = await optionalCacheGet<typeof input>('cache', 'user:1:/projects')
  expect(cached).toEqual({ name: 'original' })
  cached!.name = 'modified read'
  expect(await optionalCacheGet('cache', 'user:1:/projects')).toEqual({ name: 'original' })
  expect(await optionalCacheGet('cache', 'user:2:/projects')).toBeUndefined()
  expect(fake.put).not.toHaveBeenCalled()
})
it('does not lose an online web response when cache persistence fails', async () => {
  fake.put.mockRejectedValue(new Error('disk')); fake.get.mockRejectedValue(new Error('disk'))
  await optionalCachePut('cache', 'test', [1, 2])
  expect(await optionalCacheGet('cache', 'test')).toEqual([1, 2])
  expect(fake.put).toHaveBeenCalledExactlyOnceWith('cache', 'test', [1, 2])
})
it('combines cache keys without duplicates and clears the memory copy', async () => {
  await optionalCachePut('cache', 'memory', 1)
  fake.keys.mockResolvedValue(['memory', 'disk'])
  expect(await optionalCacheKeys('cache')).toEqual(['memory', 'disk'])
  await optionalCacheClear('cache')
  localDataAvailability.value = 'unavailable'
  expect(await optionalCacheGet('cache', 'memory')).toBeUndefined()
})
it('reads disk cache first while legacy queue overlays still own it', async () => {
  fake.get.mockResolvedValue({ title: 'queued edit' })
  expect(await optionalCacheGet('cache', 'key')).toEqual({ title: 'queued edit' })
})
it.each(['put', 'get', 'keys', 'clear'] as const)('propagates desktop %s failures instead of acknowledging memory persistence', async operation => {
  fake.optional = false
  fake[operation].mockRejectedValue(new Error('disk unavailable'))
  const run = { put: () => optionalCachePut('cache', 'x', 1), get: () => optionalCacheGet('cache', 'x'), keys: () => optionalCacheKeys('cache'), clear: () => optionalCacheClear('cache') }
  await expect(run[operation]()).rejects.toThrow('disk unavailable')
})
it('keeps the existing durable refresh-token transport when storage works', async () => {
  fake.get.mockResolvedValue('stored')
  await saveRefreshToken('rotated')
  expect(fake.put).toHaveBeenCalledWith('session', 'refresh', 'rotated')
  expect(await loadRefreshToken()).toBe('stored')
  expect(values.size).toBe(0)
})
it('shares cookie fallback before another tab can replay an old rotated token', async () => {
  fake.put.mockRejectedValue(new Error('rotation storage failed'))
  fake.get.mockResolvedValue('revoked-token')
  await saveRefreshToken('new-token')
  expect(values.get('mvs_erp_web_cookie_session')).toBe('1')
  expect(await loadRefreshToken()).toBeNull()
  await saveRefreshToken('another-token')
  expect(fake.get).not.toHaveBeenCalled()
  expect(fake.put).toHaveBeenCalledOnce()
})
it('falls back to the HttpOnly cookie when web session reads fail', async () => {
  fake.get.mockRejectedValue(new Error('unavailable'))
  expect(await loadRefreshToken()).toBeNull()
  expect(values.get('mvs_erp_web_cookie_session')).toBe('1')
})
it.each(['read', 'write'])('keeps desktop session %s durable', async operation => {
  fake.optional = false
  fake.put.mockRejectedValue(new Error('disk')); fake.get.mockRejectedValue(new Error('disk'))
  await expect(operation === 'read' ? loadRefreshToken() : saveRefreshToken('token')).rejects.toThrow('disk')
  expect(values.size).toBe(0)
})
it('fails explicitly if web cannot share a rotation decision with sibling tabs', async () => {
  fake.put.mockRejectedValue(new Error('disk'))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('localStorage unavailable') } })
  await expect(saveRefreshToken('new')).rejects.toThrow('localStorage unavailable')
})
it('clears durable tokens on logout, preserving the cookie-only marker', async () => {
  values.set('mvs_erp_web_cookie_session', '1')
  await clearRefreshToken()
  expect(fake.del).toHaveBeenCalledWith('session', 'refresh')
  expect(await loadRefreshToken()).toBeNull()
})
it('does not wait for known-unavailable optional storage on logout', async () => {
  localDataAvailability.value = 'unavailable'
  await clearRefreshToken()
  expect(fake.del).not.toHaveBeenCalled()
})

it('does not replace a volatile online response with stale disk cache after storage recovery', async () => {
  localDataAvailability.value = 'unavailable'
  await optionalCachePut('cache', 'recovered', { title: 'online version' })
  localDataAvailability.value = 'available'
  fake.get.mockResolvedValue({ title: 'stale disk' })
  expect(await optionalCacheGet('cache', 'recovered')).toEqual({ title: 'online version' })
  expect(fake.get).not.toHaveBeenCalled()
  await optionalCachePut('cache', 'recovered', { title: 'persisted' })
  fake.get.mockResolvedValue({ title: 'persisted' })
  expect(await optionalCacheGet('cache', 'recovered')).toEqual({ title: 'persisted' })
  expect(fake.get).toHaveBeenCalledOnce()
})
