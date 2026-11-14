import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ optional: true, replay: vi.fn() }))
vi.mock('./context', () => ({ platformCapabilities: { get optionalStorage() { return fake.optional } } }))
vi.mock('@/offline/outbox', () => ({ replayOutboxToCache: fake.replay }))
import { prepareCacheOverlay } from './legacyRead'
import { localDataAvailability } from './state'
beforeEach(() => { vi.resetAllMocks(); fake.optional = true; localDataAvailability.value = 'unknown' })
it('web reads never prepare legacy overlays, regardless of storage availability', async () => {
  for (const state of ['unknown', 'available', 'unavailable'] as const) {
    localDataAvailability.value = state
    await prepareCacheOverlay()
    expect(localDataAvailability.value).toBe(state)
  }
  expect(fake.replay).not.toHaveBeenCalled()
})
it('does not conceal a desktop overlay failure unrelated to storage', async () => {
  fake.optional = false
  fake.replay.mockRejectedValue(new Error('overlay failure'))
  await expect(prepareCacheOverlay()).rejects.toThrow('overlay failure')
})
it('keeps desktop overlay preparation strict even after a storage failure', async () => {
  fake.optional = false; localDataAvailability.value = 'unavailable'
  fake.replay.mockRejectedValue(new Error('disk'))
  await expect(prepareCacheOverlay()).rejects.toThrow('disk')
})
