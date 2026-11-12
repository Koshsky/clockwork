import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginMutation } from './mutationGuard'
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop' } }))

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), fresh: vi.fn(), offline: { value: false }, count: { value: 0 }, refs: { value: new Set<string>() } }))
vi.mock('./state', () => ({ isOffline: mocks.offline }))
vi.mock('./outbox', () => ({ pendingCount: mocks.count, pendingRefs: mocks.refs }))
vi.mock('./cache', () => ({ cacheGetFresh: mocks.fresh }))
vi.mock('./hydrate', () => ({ apiPath: (path: string) => path }))
vi.mock('@/settings', () => ({ warmupEnabled: new Proxy({}, { get: (_, key) => key === 'task-plan' }) }))
vi.mock('@/store', () => ({
  apiConfig: () => ({}),
  useAuthStore: () => ({ user: { id: 1, preset: 'admin' }, isAuthenticated: true }),
  useAppStore: () => ({}),
  usePlanningStore: () => ({ refreshTaskPlanning: mocks.refresh }),
  useTimesheetStore: () => ({}),
  useRbacStore: () => ({ permsLoaded: false, myPermissions: [] }),
}))
import { pullStaleCycle, stopWarmup, resumeWarmup, scheduleWarmup }  from './warmup'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.offline.value = false
  mocks.count.value = 0
  mocks.refs.value = new Set()
  mocks.fresh.mockResolvedValue(null)
  mocks.refresh.mockResolvedValue(undefined)
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  resumeWarmup()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
async function pull() {
  const pending = pullStaleCycle()
  await vi.runAllTimersAsync()
  return pending
}
describe('minute cache warmup safety', () => {
  it('refreshes expired data but leaves a fresh cached copy alone', async () => {
    expect(await pull()).toBe(1)
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(true)
    mocks.fresh.mockResolvedValue({ ts: Date.now(), data: {} })
    expect(await pull()).toBe(0)
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
  it.each(['offline', 'queued', 'quarantined'])('keeps cached edits when %s', async (mode) => {
    if (mode === 'offline') mocks.offline.value = true
    if (mode === 'queued') mocks.count.value = 1
    if (mode === 'quarantined') mocks.refs.value.add('task:7')
    expect(await pull()).toBe(0)
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it('defers warmup until an active write is settled', async () => {
    const finish = beginMutation()
    try {
      expect(await pull()).toBe(0)
      expect(mocks.refresh).not.toHaveBeenCalled()
    } finally { finish() }
    expect(await pull()).toBe(1)
  })
})

describe('runtime warmup cleanup', () => {
  it('cancels a scheduled idle warmup without starting requests', async () => {
    scheduleWarmup()
    stopWarmup()
    await vi.runAllTimersAsync()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(await pullStaleCycle()).toBe(0)
  })
  it('does not continue a stopped pull after its active request completes', async () => {
    let finish!: () => void
    mocks.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = pullStaleCycle()
    await vi.advanceTimersByTimeAsync(0)
    stopWarmup()
    finish()
    expect(await pending).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    resumeWarmup()
    expect(await pull()).toBe(1)
  })
})
