import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ optional: true, put: vi.fn(), get: vi.fn(), keys: vi.fn(), clear: vi.fn(), del: vi.fn() }))
vi.mock('./context', () => ({ platformCapabilities: { get optionalStorage() { return fake.optional } } }))
vi.mock('@/offline/db', () => ({ idbPut: fake.put, idbGet: fake.get, idbKeys: fake.keys, idbClear: fake.clear, idbDel: fake.del }))
import { optionalCachePut, optionalCacheGet, optionalCacheKeys, optionalCacheClear } from './cacheStore'
import { saveRefreshToken, loadRefreshToken } from '@/offline/session'
let values: Map<string, string>
beforeEach(async () => {
  vi.resetAllMocks(); fake.optional = true
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  await optionalCacheClear('cache')
  fake.keys.mockResolvedValue([])
})
afterEach(() => vi.unstubAllGlobals())
it.each(['put', 'get', 'keys', 'clear'] as const)('propagates desktop %s failures instead of acknowledging memory persistence', async operation => {
  fake.optional = false
  fake[operation].mockRejectedValue(new Error('disk unavailable'))
  const run = { put: () => optionalCachePut('cache', 'x', 1), get: () => optionalCacheGet('cache', 'x'), keys: () => optionalCacheKeys('cache'), clear: () => optionalCacheClear('cache') }
  await expect(run[operation]()).rejects.toThrow('disk unavailable')
})
it('keeps the existing legacy desktop refresh helper durable', async () => {
  fake.optional = false
  fake.get.mockResolvedValue('stored')
  await saveRefreshToken('rotated')
  expect(fake.put).toHaveBeenCalledWith('session', 'refresh', 'rotated')
  expect(await loadRefreshToken()).toBe('stored')
  expect(values.size).toBe(0)
})
it.each(['read', 'write'])('keeps desktop session %s durable', async operation => {
  fake.optional = false
  fake.put.mockRejectedValue(new Error('disk')); fake.get.mockRejectedValue(new Error('disk'))
  await expect(operation === 'read' ? loadRefreshToken() : saveRefreshToken('token')).rejects.toThrow('disk')
  expect(values.size).toBe(0)
})
