import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

const calls = vi.hoisted(() => ({
  sync: vi.fn(), pull: vi.fn(), warm: vi.fn(), count: vi.fn(), probe: vi.fn(),
  enabled: true, loggedOut: false,
}))
vi.mock('./state', async () => {
  const { ref } = await import('vue')
  return { isOffline: ref(false), reconnectDeadline: ref<number | null>(null), probeBackend: calls.probe }
})
vi.mock('./outbox', async () => {
  const { ref } = await import('vue')
  return { pendingCount: ref(0), refreshPendingCount: calls.count }
})
vi.mock('./sync', () => ({ syncNow: calls.sync }))
vi.mock('./warmup', () => ({ pullStaleCycle: calls.pull, scheduleWarmup: calls.warm }))
vi.mock('@/settings', () => ({ shouldAutoSync: () => calls.enabled }))
vi.mock('@/loggedOut', () => ({ isLoggedOut: () => calls.loggedOut }))

let scope: ReturnType<typeof effectScope>
let surface: EventTarget
let visibility: { hidden: boolean }

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.resetAllMocks()
  calls.enabled = true
  calls.loggedOut = false
  calls.probe.mockResolvedValue(true)
  calls.sync.mockResolvedValue(undefined)
  calls.pull.mockResolvedValue(1)
  calls.count.mockResolvedValue(undefined)
  surface = new EventTarget()
  visibility = { hidden: false }
  vi.stubGlobal('window', Object.assign(surface, { setInterval, clearInterval }))
  vi.stubGlobal('document', visibility)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  const { isOffline, reconnectDeadline } = await import('./state')
  const { pendingCount } = await import('./outbox')
  isOffline.value = false
  reconnectDeadline.value = null
  pendingCount.value = 0
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function start() {
  const monitor = await import('./connection')
  scope.run(() => monitor.startConnectionMonitor())
  return monitor
}

describe('minute autosync and connection recovery', () => {
  it('does not sync at five seconds; pushes before the minute cache refresh', async () => {
    const { pendingCount } = await import('./outbox')
    pendingCount.value = 1
    let finish!: () => void
    calls.sync.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { pendingCount.value = 0; resolve() } }))
    await start()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls.sync).not.toHaveBeenCalled()
    expect(calls.pull).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.sync).toHaveBeenCalledTimes(1)
    expect(calls.pull).not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.sync).toHaveBeenCalledTimes(1)
    expect(calls.pull).toHaveBeenCalledTimes(2)
  })

  it.each(['hidden', 'disabled', 'loggedOut'])('does no automatic work when %s', async (mode) => {
    if (mode === 'hidden') visibility.hidden = true
    if (mode === 'disabled') calls.enabled = false
    if (mode === 'loggedOut') calls.loggedOut = true
    await start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.probe).not.toHaveBeenCalled()
    expect(calls.sync).not.toHaveBeenCalled()
    expect(calls.pull).not.toHaveBeenCalled()
  })

  it('does not overlap minute cycles while an earlier push is pending', async () => {
    const { pendingCount } = await import('./outbox')
    pendingCount.value = 1
    let finish!: () => void
    calls.sync.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    await start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(calls.sync).toHaveBeenCalledTimes(1)
    expect(calls.pull).not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('stops pulls offline and restores the queue before warming the cache', async () => {
    const { isOffline } = await import('./state')
    const { pendingCount } = await import('./outbox')
    const monitor = await start()
    surface.dispatchEvent(new Event('offline'))
    await nextTick()
    expect(isOffline.value).toBe(true)
    calls.probe.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.pull).not.toHaveBeenCalled()
    expect(calls.sync).not.toHaveBeenCalled()
    pendingCount.value = 2
    calls.probe.mockResolvedValue(true)
    let finish!: () => void
    calls.sync.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { pendingCount.value = 0; resolve() } }))
    const recovering = monitor.retryConnectionNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.sync).toHaveBeenCalledTimes(1)
    expect(calls.warm).not.toHaveBeenCalled()
    finish()
    await recovering
    expect(isOffline.value).toBe(false)
    expect(calls.warm).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.pull).toHaveBeenCalledTimes(1)
  })

  it('detects HTTP cache fallback going offline and probes on the browser online event', async () => {
    const { isOffline, reconnectDeadline } = await import('./state')
    await start()
    isOffline.value = true
    await nextTick()
    expect(reconnectDeadline.value).not.toBeNull()
    surface.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(isOffline.value).toBe(false)
    expect(calls.warm).toHaveBeenCalledTimes(1)
  })
  it('defers the minute cycle while an online mutation awaits confirmation', async () => {
    const { beginMutation } = await import('./mutationGuard')
    const finish = beginMutation()
    try {
      await start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls.sync).not.toHaveBeenCalled()
      expect(calls.pull).not.toHaveBeenCalled()
    } finally { finish() }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.pull).toHaveBeenCalledTimes(1)
  })

  it('keeps the queue on push failure and retries before the next pull', async () => {
    const { pendingCount } = await import('./outbox')
    pendingCount.value = 1
    calls.sync.mockRejectedValueOnce(new Error('network interrupted'))
      .mockImplementationOnce(async () => { pendingCount.value = 0 })
    await start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.pull).not.toHaveBeenCalled()
    expect(pendingCount.value).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.sync).toHaveBeenCalledTimes(2)
    expect(calls.pull).toHaveBeenCalledTimes(1)
  })

  it('suspends automatic reconnect probes while the tab is hidden', async () => {
    await start()
    surface.dispatchEvent(new Event('offline'))
    await nextTick()
    visibility.hidden = true
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.probe).not.toHaveBeenCalled()
    visibility.hidden = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls.probe).toHaveBeenCalledTimes(1)
    expect(calls.warm).toHaveBeenCalledTimes(1)
  })

})
