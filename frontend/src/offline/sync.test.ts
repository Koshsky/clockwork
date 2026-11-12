import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  count: { value: 1 }, offline: { value: true }, loggedOut: false, expired: true,
  probe: vi.fn(), refresh: vi.fn(), settle: vi.fn(), flush: vi.fn(), warm: vi.fn(),
}))
vi.mock('@/store', () => ({
  useAuthStore: () => ({ accessExpired: () => fake.expired, refreshSession: fake.refresh, waitForSessionRefresh: fake.settle }),
  useAppStore: () => ({}), usePlanningStore: () => ({}), useTimesheetStore: () => ({}), useRbacStore: () => ({}),
}))
vi.mock('./state', () => ({ isOffline: fake.offline, probeBackend: fake.probe }))
vi.mock('@/loggedOut', () => ({ isLoggedOut: () => fake.loggedOut }))
vi.mock('@/settings', () => ({ shouldAutoSync: () => false }))
vi.mock('./warmup', () => ({ warmNow: fake.warm }))
vi.mock('./outbox', () => ({
  flushOutbox: fake.flush, pendingCount: fake.count, refreshPendingCount: vi.fn(async () => {}),
  replayOutboxToCache: vi.fn(), resetFailedRetries: vi.fn(),
}))
import { syncAll, syncNow, retryFailed, syncNotice } from './sync'

beforeEach(() => {
  vi.clearAllMocks()
  fake.count.value = 1
  fake.offline.value = true
  fake.loggedOut = false
  fake.expired = true
  fake.probe.mockResolvedValue(true)
  fake.settle.mockResolvedValue(undefined)
  fake.refresh.mockImplementation(async () => { fake.expired = false; return true })
  fake.flush.mockResolvedValue({ ok: 1, failed: 0, interrupted: false, entities: new Set(), failedEntries: [] })
  fake.warm.mockResolvedValue(false)
  syncNotice.value = null
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('manual queue recovery with automatic sync disabled', () => {
  it('settles an older failed renewal before probing and restoring the online session', async () => {
    let finish!: () => void
    fake.settle.mockImplementation(() => new Promise(resolve => { finish = () => { fake.offline.value = true; resolve(undefined) } }))
    const pending = syncNow()
    await vi.waitFor(() => expect(fake.settle).toHaveBeenCalledTimes(1))
    expect(fake.probe).not.toHaveBeenCalled()
    expect(fake.flush).not.toHaveBeenCalled()
    finish()
    await pending
    expect(fake.offline.value).toBe(false)
    expect(fake.refresh).toHaveBeenCalledTimes(1)
    expect(fake.flush).toHaveBeenCalledTimes(1)
  })

  it.each([syncNow, syncAll, retryFailed])('restores the session before sending pending changes', async run => {
    const order: string[] = []
    fake.probe.mockImplementation(async () => { order.push('probe'); return true })
    fake.refresh.mockImplementation(async () => {
      expect(fake.offline.value).toBe(false)
      order.push('refresh'); fake.expired = false; return true
    })
    fake.flush.mockImplementation(async () => {
      order.push('flush')
      return { ok: 1, failed: 0, interrupted: false, entities: new Set(), failedEntries: [] }
    })
    await run()
    expect(order).toEqual(['probe', 'refresh', 'flush'])
    expect(syncNotice.value?.ok).toBe(1)
  })

  it.each(['unreachable', 'logged-out', 'rejected-refresh', 'missing-token', 'lost-during-refresh'])('retains the queue when %s', async condition => {
    if (condition === 'unreachable') fake.probe.mockResolvedValue(false)
    if (condition === 'logged-out') fake.loggedOut = true
    if (condition === 'rejected-refresh') fake.refresh.mockResolvedValue(false)
    if (condition === 'missing-token') fake.refresh.mockResolvedValue(true)
    if (condition === 'lost-during-refresh') fake.refresh.mockImplementation(async () => { fake.offline.value = true; return true })
    await syncNow()
    expect(fake.flush).not.toHaveBeenCalled()
    expect(fake.count.value).toBe(1)
    expect(syncNotice.value).toMatchObject({ ok: 0, failed: 0, interrupted: true })
    if (['unreachable', 'logged-out'].includes(condition)) expect(fake.refresh).not.toHaveBeenCalled()
  })

  it('reuses a valid session without rotating the refresh token', async () => {
    fake.expired = false
    await syncNow()
    expect(fake.refresh).not.toHaveBeenCalled()
    expect(fake.flush).toHaveBeenCalledTimes(1)
    expect(fake.offline.value).toBe(false)
  })

  it('coalesces simultaneous manual requests while session restoration is pending', async () => {
    let finish!: () => void
    fake.refresh.mockImplementation(() => new Promise(resolve => { finish = () => { fake.expired = false; resolve(true) } }))
    const first = syncNow(), second = syncNow()
    await vi.waitFor(() => expect(fake.refresh).toHaveBeenCalledTimes(1))
    expect(fake.flush).not.toHaveBeenCalled()
    finish()
    await Promise.all([first, second])
    expect(fake.flush).toHaveBeenCalledTimes(1)
  })
})
