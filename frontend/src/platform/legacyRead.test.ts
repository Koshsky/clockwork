import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ optional: true, replay: vi.fn() }))
vi.mock('./context', () => ({ platformCapabilities: { get optionalStorage() { return fake.optional } } }))
vi.mock('@/offline/outbox', () => ({ replayOutboxToCache: fake.replay }))
import { prepareCacheOverlay } from './legacyRead'
import { localDataAvailability } from './state'
beforeEach(() => { vi.resetAllMocks(); fake.optional = true; localDataAvailability.value = 'unknown' })
it('replays saved edits when web storage is readable', async () => {
  await prepareCacheOverlay()
  expect(fake.replay).toHaveBeenCalledOnce()
})
it('does not keep retrying known unavailable optional storage during navigation', async () => {
  localDataAvailability.value = 'unavailable'
  await prepareCacheOverlay()
  expect(fake.replay).not.toHaveBeenCalled()
})
it('lets web read API data after a storage failure without declaring the queue empty', async () => {
  fake.replay.mockImplementation(async () => { localDataAvailability.value = 'unavailable'; throw new Error('disk') })
  await expect(prepareCacheOverlay()).resolves.toBeUndefined()
  expect(localDataAvailability.value).toBe('unavailable')
})
it('does not conceal an overlay failure unrelated to optional storage', async () => {
  fake.replay.mockRejectedValue(new Error('overlay failure'))
  await expect(prepareCacheOverlay()).rejects.toThrow('overlay failure')
})
it('keeps desktop overlay preparation strict even after a storage failure', async () => {
  fake.optional = false; localDataAvailability.value = 'unavailable'
  fake.replay.mockRejectedValue(new Error('disk'))
  await expect(prepareCacheOverlay()).rejects.toThrow('disk')
})
