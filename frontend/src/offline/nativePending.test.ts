import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ commands: vi.fn(), session: { value: { contextId: 'session-0' } }, generation: 0 }))
vi.mock('./desktopQueue', () => ({ nativeQueue: {}, nativeCommands: fixture.commands, nativeEntry: (row: unknown) => row, nativeDiscardPlan: vi.fn(), enqueueNative: vi.fn(), queueRequest: vi.fn() }))
vi.mock('@/session/desktop', () => ({ desktopSession: {}, desktopSessionState: fixture.session }))
vi.mock('./cacheApply', () => ({ applyToCache: vi.fn() }))
vi.mock('./state', () => ({ probeBackend: vi.fn() }))
vi.mock('@/config', () => ({ getApiUrl: () => 'https://fixture.test/api/v1' }))
vi.mock('../token', () => ({ getAccessToken: () => '' }))
import { pendingCount, pendingRefs, queueItems, refreshPendingCount } from './outbox'
import { legacyQueueAvailability } from '@/platform/state'
const row = { id: 'operation', ts: 1, method: 'PUT', url: '/api/v1/task/7', entity: 'task', body: {} }
const defer = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
beforeEach(async () => {
  vi.resetAllMocks(); fixture.session.value = { contextId: 'session-' + ++fixture.generation }
  fixture.commands.mockResolvedValue([]); await refreshPendingCount()
})
it('an old empty queue response cannot erase newer pending work', async () => {
  const held = defer<unknown[]>(); fixture.commands.mockReturnValueOnce(held.promise)
  const old = refreshPendingCount(); fixture.commands.mockResolvedValueOnce([row]); await refreshPendingCount()
  held.resolve([]); await old
  expect(pendingCount.value).toBe(1); expect(pendingRefs.value.has('task:7')).toBe(true)
  expect(queueItems.value).toHaveLength(1)
})
it('a transient native read failure keeps known pending work visible', async () => {
  fixture.commands.mockResolvedValueOnce([row]); await refreshPendingCount()
  const previous = pendingRefs.value
  fixture.commands.mockRejectedValueOnce(new Error('IPC unavailable')); await refreshPendingCount()
  expect(pendingCount.value).toBe(1); expect(pendingRefs.value).toBe(previous)
  expect(legacyQueueAvailability.value).toBe('unavailable')
})
it('a late failed read cannot replace a newer successful queue status', async () => {
  const held = defer<unknown[]>(); fixture.commands.mockReturnValueOnce(held.promise)
  const old = refreshPendingCount(); fixture.commands.mockResolvedValueOnce([row]); await refreshPendingCount()
  held.reject(new Error('Old IPC closed')); await old
  expect(legacyQueueAvailability.value).toBe('pending'); expect(pendingCount.value).toBe(1)
})
it('a previous session cannot publish pending references after a new login', async () => {
  const held = defer<unknown[]>(); fixture.commands.mockReturnValueOnce(held.promise)
  const old = refreshPendingCount(); fixture.session.value = { contextId: 'new-login' }
  fixture.commands.mockResolvedValueOnce([]); await refreshPendingCount(); held.resolve([row]); await old
  expect(pendingCount.value).toBe(0); expect(pendingRefs.value.size).toBe(0); expect(queueItems.value).toEqual([])
})
it('a failed first read in another session cannot inherit the previous queue', async () => {
  fixture.commands.mockResolvedValueOnce([row]); await refreshPendingCount()
  fixture.session.value = { contextId: 'another-login' }; fixture.commands.mockRejectedValueOnce(new Error('Unavailable'))
  await refreshPendingCount()
  expect(pendingCount.value).toBe(0); expect(queueItems.value).toEqual([])
  expect(legacyQueueAvailability.value).toBe('unavailable')
})
it('a slower newer read does not starve an already completed pending snapshot', async () => {
  const first = defer<unknown[]>(), second = defer<unknown[]>()
  fixture.commands.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const a = refreshPendingCount(), b = refreshPendingCount()
  first.resolve([row]); await a
  expect(pendingCount.value).toBe(1)
  second.resolve([]); await b
  expect(pendingCount.value).toBe(0)
})
