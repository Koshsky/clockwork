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
import type { ApplicationRuntime } from './lifecycle'
let runtime: ApplicationRuntime | undefined
let surface: EventTarget
let visibility: { hidden: boolean }
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
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
it.each(['unknown', 'empty', 'unavailable'] as const)('does not adopt or clear a %s legacy queue', async status => {
  legacyQueueAvailability.value = status
  await web(); await vi.advanceTimersByTimeAsync(60000)
  expect(fake.prepare).not.toHaveBeenCalled()
  expect(fake.push).not.toHaveBeenCalled()
  expect(legacyQueueAvailability.value).toBe(status)
})
it('recovers a known pending queue before minute reads', async () => {
  legacyQueueAvailability.value = 'pending'
  const wait = gate(); fake.push.mockReturnValue(wait.promise)
  await web()
  expect(fake.prepare).toHaveBeenCalledOnce()
  expect(fake.push).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60000)
  expect(fake.pull).not.toHaveBeenCalled()
  expect(fake.push).toHaveBeenCalledOnce()
  expect(fake.prepare).toHaveBeenCalledOnce()
  wait.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(fake.pull).toHaveBeenCalledOnce()
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
it('keeps pending work after recovery failure and does not pull over it', async () => {
  legacyQueueAvailability.value = 'pending'; fake.push.mockRejectedValue(new Error('lost response'))
  await web(); await vi.advanceTimersByTimeAsync(60000)
  expect(fake.pull).not.toHaveBeenCalled()
  expect(legacyQueueAvailability.value).toBe('pending')
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

it('discovers edits queued by another tab before the next minute pull', async () => {
  await web()
  fake.count.mockImplementation(async () => { legacyQueueAvailability.value = 'pending' })
  fake.push.mockImplementation(async () => { legacyQueueAvailability.value = 'empty' })
  await vi.advanceTimersByTimeAsync(60000)
  expect(fake.prepare).toHaveBeenCalledOnce()
  expect(fake.push).toHaveBeenCalledOnce()
  expect(fake.pull).toHaveBeenCalledOnce()
  expect(fake.push.mock.invocationCallOrder[0]).toBeLessThan(fake.pull.mock.invocationCallOrder[0])
})
it('uses the selected web retry action to recover pending legacy work immediately', async () => {
  legacyQueueAvailability.value = 'pending'; fake.enabled = false; isOffline.value = true
  await web()
  fake.enabled = true
  await runtime!.retryConnection()
  expect(isOffline.value).toBe(false)
  expect(fake.push).toHaveBeenCalledOnce()
  expect(fake.monitor).not.toHaveBeenCalled()
})
