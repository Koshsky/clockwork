import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopServiceState } from '@/data/desktopBridge'
const fixture = vi.hoisted(() => ({ refresh: vi.fn(), reload: vi.fn(), detach: vi.fn(), active: false, native: false, permissions: vi.fn(), offline: { value: false }, deadline: { value: null }, warmed: { value: null }, progress: { value: null }, listener: null as null | ((state: DesktopServiceState) => void), storage: { value: 'unknown' } }))
vi.mock('./nativeHydration', () => ({ nativeSnapshotReloaders: () => [{ name: 'native', run: fixture.reload }] }))
vi.mock('@/store', () => ({ useRbacStore: () => ({ refreshPermissions: fixture.permissions }) }))
vi.mock('./desktopQueue', () => ({ get nativeSync() { return fixture.native } }))
vi.mock('./state', () => ({ isOffline: fixture.offline, reconnectDeadline: fixture.deadline }))
vi.mock('./warmup', () => ({ warmupProgress: fixture.progress, lastWarmedAt: fixture.warmed }))
vi.mock('./outbox', () => ({ refreshPendingCount: fixture.refresh }))
vi.mock('./sync', () => ({ reloadDomainsFor: (entity: string) => [{ name: entity, run: fixture.reload }] }))
vi.mock('./mutationGuard', () => ({ hasActiveMutations: () => fixture.active }))
vi.mock('@/platform/state', () => ({ localDataAvailability: fixture.storage }))
import { nativeQueueChanged } from './nativeEvents'
let stop: () => void
const state = (revision = 1, contextId = 'context') => ({ storage: { phase: 'ready' }, queue: { revision, contextId, running: false } }) as DesktopServiceState
beforeEach(() => {
  vi.useFakeTimers(); fixture.refresh.mockReset(); fixture.reload.mockReset(); fixture.detach.mockReset(); fixture.active = false; fixture.native = false; fixture.permissions.mockReset()
  vi.stubGlobal('window', { erpDesktop: { service: { subscribe: (listener: (state: DesktopServiceState) => void) => { fixture.listener = listener; return fixture.detach } } } })
  stop = nativeQueueChanged()
})
afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('updates pending state and shared stores after a durable main-process change', async () => {
  fixture.listener!(state()); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledOnce(); expect(fixture.reload).toHaveBeenCalledTimes(9)
})
it('coalesces a burst of queue revisions', async () => {
  fixture.listener!(state(1)); fixture.listener!(state(2)); fixture.listener!(state(3)); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledOnce()
})
it('ignores unchanged queue revisions', async () => {
  fixture.listener!(state()); await vi.advanceTimersByTimeAsync(50); fixture.listener!(state()); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledOnce(); expect(fixture.storage.value).toBe('available')
})
it('waits for the originating optimistic mutation before reloading', async () => {
  fixture.active = true; fixture.listener!(state()); await vi.advanceTimersByTimeAsync(200)
  expect(fixture.refresh).not.toHaveBeenCalled(); fixture.active = false; await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledOnce()
})
it('refreshes a changed account context with the same revision', async () => {
  fixture.listener!(state()); await vi.advanceTimersByTimeAsync(50); fixture.listener!(state(1, 'other')); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledTimes(2)
})
it('detaches subscriptions and timers when the runtime stops', async () => {
  fixture.listener!(state()); stop(); await vi.advanceTimersByTimeAsync(100)
  expect(fixture.refresh).not.toHaveBeenCalled(); expect(fixture.detach).toHaveBeenCalledOnce()
})

it('applies main reachability and progress without reloading unchanged snapshots', async () => {
  fixture.listener!(state()); await vi.advanceTimersByTimeAsync(50)
  fixture.listener!({ ...state(), sync: { revision: 2, contextId: 'context', running: true, reachable: false, progress: 25, lastPullAt: 123, reconnectAt: 456 } })
  await vi.advanceTimersByTimeAsync(50)
  expect(fixture.offline.value).toBe(true); expect(fixture.deadline.value).toBe(456)
  expect(fixture.progress.value).toBe(25); expect(fixture.warmed.value).toBe(123)
  expect(fixture.refresh).toHaveBeenCalledOnce()
})
it('refreshes permissions before applying native domain snapshots', async () => {
  fixture.native = true; fixture.listener!(state()); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.permissions).toHaveBeenCalledOnce()
  expect(fixture.permissions.mock.invocationCallOrder[0]).toBeLessThan(fixture.reload.mock.invocationCallOrder[0]!)
})
it('reconciles again when another snapshot arrives during hydration', async () => {
  let release!: () => void
  fixture.reload.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  fixture.listener!(state(1)); await vi.advanceTimersByTimeAsync(50)
  fixture.listener!(state(2)); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledTimes(2)
  release(); await vi.advanceTimersByTimeAsync(50)
  expect(fixture.reload.mock.calls.length).toBeGreaterThan(9)
})
it('keeps the latest snapshot deferred throughout a drag preview', async () => {
  fixture.active = true; fixture.listener!(state(1)); await vi.advanceTimersByTimeAsync(50)
  fixture.listener!(state(2)); await vi.advanceTimersByTimeAsync(100)
  expect(fixture.reload).not.toHaveBeenCalled()
  fixture.active = false; await vi.advanceTimersByTimeAsync(50)
  expect(fixture.refresh).toHaveBeenCalledOnce()
})
