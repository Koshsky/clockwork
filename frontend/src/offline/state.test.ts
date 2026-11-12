import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@/session/desktop', () => ({ desktopSession: null }))
vi.mock('@/config', () => ({ getApiUrl: () => '/api/v1' }))
import { probeBackend } from './state'
import { backendReachability } from '@/platform/state'
beforeEach(() => {
  backendReachability.value = 'unknown'
  vi.stubGlobal('window', { setTimeout, clearTimeout })
})
afterEach(() => vi.unstubAllGlobals())
it.each([200, 503, 'network'] as const)('a controller-owned %s probe does not publish stale metadata by itself', async status => {
  vi.stubGlobal('fetch', status === 'network' ? vi.fn().mockRejectedValue(new Error('Disconnected')) : vi.fn().mockResolvedValue({ status }))
  expect(await probeBackend({ publish: false })).toBe(status === 200)
  expect(backendReachability.value).toBe('unknown')
})
it('keeps the existing publishing behavior for legacy desktop callers', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
  expect(await probeBackend()).toBe(true)
  expect(backendReachability.value).toBe('reachable')
})
