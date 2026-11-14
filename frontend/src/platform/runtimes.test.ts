import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
const fake = vi.hoisted(() => ({
  probe: vi.fn(), count: vi.fn(), pull: vi.fn(), warm: vi.fn(), prepare: vi.fn(), push: vi.fn(),
  session: vi.fn(), stopSession: vi.fn(), monitor: vi.fn(), stopMonitor: vi.fn(), version: vi.fn(), offlineInit: vi.fn(),
  resumeWarm: vi.fn(), stopWarm: vi.fn(), resumeRefresh: vi.fn(), stopRefresh: vi.fn(),
  enabled: true, loggedOut: false, mutation: false,
}))
vi.mock('@/store/data/apiReads', () => ({ cancelApiReads: vi.fn() }))
vi.mock('@/offline/state', async () => {
  const { ref } = await import('vue')
  return { isOffline: ref(false), reconnectDeadline: ref<number | null>(null), probeBackend: fake.probe }
})
vi.mock('@/offline/outbox', () => ({ refreshPendingCount: fake.count }))
vi.mock('@/offline/cache', () => ({ ensureCacheVersion: fake.version }))
vi.mock('@/offline/connection', () => ({ startConnectionMonitor: fake.monitor, retryConnectionNow: fake.probe }))
vi.mock('@/offline/mutationGuard', () => ({ hasActiveMutations: () => fake.mutation }))
vi.mock('@/offline/sync', () => ({ startSessionMaintenance: fake.session, stopDomainRefresh: fake.stopRefresh, resumeDomainRefresh: fake.resumeRefresh, initOfflineSync: fake.offlineInit }))
vi.mock('@/offline/warmup', () => ({ pullStaleCycle: fake.pull, scheduleWarmup: fake.warm, stopWarmup: fake.stopWarm, resumeWarmup: fake.resumeWarm }))
vi.mock('./legacyQueue', () => ({ legacyQueueRecovery: () => ({ prepare: fake.prepare, push: fake.push }) }))
vi.mock('@/settings', () => ({ shouldAutoSync: () => fake.enabled }))
vi.mock('@/loggedOut', () => ({ isLoggedOut: () => fake.loggedOut }))
vi.mock('@/store', async () => {
  const { reactive } = await import('vue')
  const auth = reactive({ isAuthenticated: false, sessionMode: 'online' })
  return { useAuthStore: () => auth }
})
import { createWebRuntime } from './web'
import { createDesktopRuntime } from './desktop'
import { backendReachability, legacyQueueAvailability } from './state'
import { isOffline, reconnectDeadline } from '@/offline/state'
import { useAuthStore } from '@/store'
import type { ApplicationRuntime } from './lifecycle'
let runtime: ApplicationRuntime | undefined
let surface: EventTarget
let visibility: { hidden: boolean }
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  useAuthStore().isAuthenticated = false
  fake.enabled = true; fake.loggedOut = false; fake.mutation = false
  fake.probe.mockResolvedValue(true); fake.count.mockResolvedValue(undefined); fake.pull.mockResolvedValue(1)
  fake.prepare.mockResolvedValue(undefined); fake.push.mockResolvedValue(undefined)
  fake.session.mockReturnValue(fake.stopSession); fake.monitor.mockReturnValue(fake.stopMonitor)
  fake.version.mockResolvedValue(undefined); fake.offlineInit.mockResolvedValue(undefined)
  legacyQueueAvailability.value = 'empty'; backendReachability.value = 'unknown'; isOffline.value = false; reconnectDeadline.value = null
  surface = new EventTarget(); visibility = { hidden: false }
  vi.stubGlobal('window', Object.assign(surface, { setInterval, clearInterval }))
  vi.stubGlobal('document', visibility)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
})
afterEach(() => { runtime?.stop(); runtime = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function web() { runtime = createWebRuntime(); await runtime.start(); await vi.advanceTimersByTimeAsync(0); return runtime }
it('web starts without running the offline engine or waiting for IndexedDB discovery', async () => {
  fake.count.mockReturnValue(new Promise(() => {}))
  await web()
  expect(runtime?.phase.value).toBe('running')
  expect(fake.version).not.toHaveBeenCalled()
  expect(fake.offlineInit).not.toHaveBeenCalled()
  expect(fake.monitor).not.toHaveBeenCalled()
  expect(fake.prepare).not.toHaveBeenCalled()
  expect(fake.session).toHaveBeenCalledOnce()
})
it('web refreshes at one minute, without starting the legacy engine', async () => {
  await web(); await vi.advanceTimersByTimeAsync(59999)
  expect(fake.pull).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(fake.pull).toHaveBeenCalledOnce()
  expect(fake.push).not.toHaveBeenCalled()
})
it('ignores legacy queues while minute API refresh remains active', async () => {
  fake.prepare.mockImplementation(() => { throw new Error('Legacy recovery must not run') })
  fake.push.mockImplementation(() => { throw new Error('Legacy sender must not run') })
  await web()
  for (const status of ['unknown', 'empty', 'unavailable', 'pending'] as const) {
    legacyQueueAvailability.value = status
    await vi.advanceTimersByTimeAsync(60000)
    expect(legacyQueueAvailability.value).toBe(status)
  }
  expect(fake.prepare).not.toHaveBeenCalled()
  expect(fake.push).not.toHaveBeenCalled()
  expect(fake.count).not.toHaveBeenCalled()
  expect(fake.pull).toHaveBeenCalledTimes(4)
})
it.each(['hidden', 'disabled', 'loggedOut', 'mutation'])('defers web background work when %s', async mode => {
  if (mode === 'hidden') visibility.hidden = true
  if (mode === 'disabled') fake.enabled = false
  if (mode === 'loggedOut') fake.loggedOut = true
  if (mode === 'mutation') fake.mutation = true
  await web(); await vi.advanceTimersByTimeAsync(120000)
  expect(fake.pull).not.toHaveBeenCalled()
  expect(fake.push).not.toHaveBeenCalled()
})
it('does not overlap web minute pulls', async () => {
  fake.pull.mockReturnValue(new Promise(() => {}))
  await web(); await vi.advanceTimersByTimeAsync(180000)
  expect(fake.pull).toHaveBeenCalledOnce()
})
it('handles offline and reconnect independently of queue availability', async () => {
  await web(); surface.dispatchEvent(new Event('offline'))
  expect(isOffline.value).toBe(true)
  expect(backendReachability.value).toBe('unreachable')
  expect(reconnectDeadline.value).not.toBeNull()
  surface.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0)
  expect(isOffline.value).toBe(false)
  expect(backendReachability.value).toBe('reachable')
  expect(fake.warm).toHaveBeenCalledOnce()
})
it.each(['disabled', 'hidden'])('updates web reachability on reconnect when data refresh is %s', async mode => {
  fake.enabled = mode !== 'disabled'; visibility.hidden = mode === 'hidden'; isOffline.value = true
  await web(); surface.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0)
  expect(isOffline.value).toBe(false)
  expect(backendReachability.value).toBe('reachable')
  expect(fake.warm).not.toHaveBeenCalled(); expect(fake.push).not.toHaveBeenCalled()
})
it.each([false, true])('recovers a backend-only outage at its deadline with auto-refresh off and hidden=%s', async hidden => {
  fake.enabled = false; visibility.hidden = hidden; useAuthStore().isAuthenticated = true
  fake.probe.mockResolvedValue(false)
  await web()
  // An HTTP failure does not emit a browser offline/online event or set a retry deadline.
  isOffline.value = true; backendReachability.value = 'unreachable'
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.probe).toHaveBeenCalledOnce()
  expect(isOffline.value).toBe(true)
  const deadline = reconnectDeadline.value
  expect(deadline).toBe(Date.now() + 60000)
  fake.probe.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(59999)
  expect(fake.probe).toHaveBeenCalledOnce()
  expect(isOffline.value).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(fake.probe).toHaveBeenCalledTimes(2)
  expect(isOffline.value).toBe(false)
  expect(backendReachability.value).toBe('reachable')
  expect(reconnectDeadline.value).toBeNull()
  await vi.advanceTimersByTimeAsync(60000)
  expect(fake.pull).not.toHaveBeenCalled(); expect(fake.warm).not.toHaveBeenCalled(); expect(fake.push).not.toHaveBeenCalled()
})
it('a hidden authenticated tab monitors backend recovery without starting data refresh', async () => {
  visibility.hidden = true; useAuthStore().isAuthenticated = true
  fake.probe.mockResolvedValue(false)
  await web(); await vi.advanceTimersByTimeAsync(10000)
  expect(isOffline.value).toBe(true)
  fake.probe.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(60000)
  expect(fake.probe).toHaveBeenCalledTimes(2)
  expect(isOffline.value).toBe(false)
  expect(fake.pull).not.toHaveBeenCalled(); expect(fake.warm).not.toHaveBeenCalled()
})
it.each(['anonymous', 'logged out'])('heartbeat never probes when session=%s', async session => {
  fake.enabled = false
  useAuthStore().isAuthenticated = session !== 'anonymous'
  fake.loggedOut = session === 'logged out'
  isOffline.value = true; reconnectDeadline.value = Date.now() + 60000
  await web(); await vi.advanceTimersByTimeAsync(120000)
  expect(fake.probe).not.toHaveBeenCalled(); expect(fake.pull).not.toHaveBeenCalled()
})
it('logout cancels scheduled liveness retries without a late data pull', async () => {
  fake.enabled = false; useAuthStore().isAuthenticated = true
  fake.probe.mockResolvedValue(false)
  await web(); await vi.advanceTimersByTimeAsync(10000)
  expect(fake.probe).toHaveBeenCalledOnce()
  fake.loggedOut = true; useAuthStore().isAuthenticated = false
  await vi.advanceTimersByTimeAsync(120000)
  expect(fake.probe).toHaveBeenCalledOnce()
  expect(fake.pull).not.toHaveBeenCalled(); expect(fake.warm).not.toHaveBeenCalled()
})
it('does not lose a reconnect event behind an older in-flight health probe', async () => {
  const wait = gate()
  fake.probe.mockImplementationOnce(async () => { await wait.promise; return false })
  await web(); surface.dispatchEvent(new Event('offline')); surface.dispatchEvent(new Event('online'))
  wait.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(fake.probe).toHaveBeenCalledTimes(2)
  expect(isOffline.value).toBe(false)
  expect(backendReachability.value).toBe('reachable')
})
it('a health response from before a network loss cannot mark the tab online', async () => {
  const wait = gate()
  fake.probe.mockImplementationOnce(async () => { await wait.promise; return true })
  await web(); surface.dispatchEvent(new Event('offline')); wait.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(isOffline.value).toBe(true)
  expect(backendReachability.value).toBe('unreachable')
})
it('stops timers, listeners, watchers and session maintenance on web teardown', async () => {
  await web(); runtime!.stop()
  legacyQueueAvailability.value = 'pending'; surface.dispatchEvent(new Event('offline'))
  await nextTick(); await vi.advanceTimersByTimeAsync(120000)
  expect(isOffline.value).toBe(false)
  expect(fake.prepare).not.toHaveBeenCalled()
  expect(fake.pull).not.toHaveBeenCalled()
  expect(fake.stopSession).toHaveBeenCalledOnce()
  expect(fake.stopWarm).toHaveBeenCalledOnce()
  expect(fake.stopRefresh).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
it('does not resurrect an offline monitor when a late probe finishes after stop', async () => {
  const wait = gate(); fake.probe.mockImplementation(async () => { await wait.promise; return false })
  await web(); runtime!.stop(); wait.resolve(); await vi.advanceTimersByTimeAsync(120000)
  expect(isOffline.value).toBe(false)
  expect(reconnectDeadline.value).toBeNull()
  expect(fake.probe).toHaveBeenCalledOnce()
})
it('desktop initializes cache and queue before starting legacy monitors', async () => {
  const wait = gate(); fake.version.mockReturnValue(wait.promise)
  runtime = createDesktopRuntime(); const start = runtime.start(); await Promise.resolve()
  expect(fake.offlineInit).not.toHaveBeenCalled()
  wait.resolve(); await start
  expect(fake.offlineInit).toHaveBeenCalledOnce()
  expect(fake.monitor).toHaveBeenCalledOnce()
  expect(fake.session).toHaveBeenCalledOnce()
  runtime.stop()
  expect(fake.stopMonitor).toHaveBeenCalledOnce()
})
it('desktop does not start the queue after stopping during cache preparation', async () => {
  const wait = gate(); fake.version.mockReturnValue(wait.promise)
  runtime = createDesktopRuntime(); const start = runtime.start(); await Promise.resolve(); runtime.stop(); wait.resolve(); await start
  expect(fake.offlineInit).not.toHaveBeenCalled()
  expect(fake.monitor).not.toHaveBeenCalled()
})
it('desktop does not start monitors after stopping during queue preparation', async () => {
  const wait = gate(); fake.offlineInit.mockReturnValue(wait.promise)
  runtime = createDesktopRuntime(); const start = runtime.start(); await vi.advanceTimersByTimeAsync(0); runtime.stop(); wait.resolve(); await start
  expect(fake.monitor).not.toHaveBeenCalled()
  const active = fake.offlineInit.mock.calls[0][0] as () => boolean
  expect(active()).toBe(false)
})
it('desktop startup failure is visible and releases acquired services', async () => {
  fake.offlineInit.mockRejectedValue(new Error('disk'))
  runtime = createDesktopRuntime()
  await expect(runtime.start()).rejects.toThrow('disk')
  expect(fake.stopWarm).toHaveBeenCalledOnce()
  expect(fake.monitor).not.toHaveBeenCalled()
})

it('web retry restores connectivity without sending a legacy queue', async () => {
  legacyQueueAvailability.value = 'pending'; fake.enabled = false; isOffline.value = true
  await web()
  fake.enabled = true
  await runtime!.retryConnection()
  expect(isOffline.value).toBe(false)
  expect(fake.push).not.toHaveBeenCalled()
  expect(fake.warm).toHaveBeenCalledOnce()
  expect(fake.monitor).not.toHaveBeenCalled()
})
