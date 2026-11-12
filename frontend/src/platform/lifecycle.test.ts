import { afterEach, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeScope } from './lifecycle'
import { createRuntimeHost, currentRuntime, waitForPlatform } from './current'
import { detectCapabilities } from './capabilities'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
afterEach(() => { currentRuntime.value?.stop(); currentRuntime.value = null; vi.useRealTimers(); vi.restoreAllMocks() })

it.each([undefined, null, {}, { isElectron: false }, { isElectron: 'true' }])('selects web capabilities for %j', bridge => {
  expect(detectCapabilities(bridge)).toEqual({ kind: 'web', serverSelection: false, offlineBootstrap: false, optionalStorage: true, bootstrapBoundMs: 0, sessionRestoreBoundMs: 2500 })
})
it('selects immutable desktop capabilities only from the preload flag', () => {
  const caps = detectCapabilities({ isElectron: true })
  expect(caps).toMatchObject({ kind: 'desktop', serverSelection: true, offlineBootstrap: true, optionalStorage: false, bootstrapBoundMs: 4000 })
  expect(Object.isFrozen(caps)).toBe(true)
})
it('starts once and cleans up once in reverse order', async () => {
  const order: number[] = []
  const init = vi.fn(async (scope: RuntimeScope) => { scope.onStop(() => order.push(1)); scope.onStop(() => order.push(2)) })
  const runtime = createRuntime('web', init, vi.fn())
  const first = runtime.start()
  expect(runtime.start()).toBe(first)
  await first
  expect(runtime.phase.value).toBe('running')
  runtime.stop(); runtime.stop()
  await runtime.start()
  expect(init).toHaveBeenCalledTimes(1)
  expect(order).toEqual([2, 1])
  expect(runtime.phase.value).toBe('stopped')
})
it('does not initialize after a synchronous stop', async () => {
  const init = vi.fn(async () => {})
  const runtime = createRuntime('desktop', init, vi.fn())
  const start = runtime.start(); runtime.stop(); await start
  expect(init).not.toHaveBeenCalled()
})
it('immediately releases a resource acquired after stop', async () => {
  const gate = deferred(), cleanup = vi.fn(), retry = vi.fn()
  let active = true
  const runtime = createRuntime('desktop', async scope => { await gate.promise; active = scope.active(); scope.onStop(cleanup) }, retry)
  const start = runtime.start(); await Promise.resolve(); runtime.stop(); gate.resolve(); await start
  expect(active).toBe(false)
  expect(cleanup).toHaveBeenCalledTimes(1)
  await runtime.retryConnection()
  expect(retry).not.toHaveBeenCalled()
})
it('cleans up initialization failure without hiding the error', async () => {
  const cleanup = vi.fn(), retry = vi.fn()
  const runtime = createRuntime('web', async scope => { scope.onStop(cleanup); throw new Error('failed') }, retry)
  await expect(runtime.start()).rejects.toThrow('failed')
  expect(runtime.phase.value).toBe('failed')
  expect(cleanup).toHaveBeenCalledTimes(1)
  await runtime.retryConnection()
  expect(retry).not.toHaveBeenCalled()
})
it('continues cleanup when one resource throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const cleanup = vi.fn()
  const runtime = createRuntime('web', async scope => { scope.onStop(cleanup); scope.onStop(() => { throw new Error('cleanup') }) }, vi.fn())
  await runtime.start(); runtime.stop()
  expect(cleanup).toHaveBeenCalledOnce()
})
it('ignores a stale factory and restarts with a fresh runtime', async () => {
  const gate = deferred()
  const old = createRuntime('web', vi.fn(async () => {}), vi.fn())
  const fresh = createRuntime('web', vi.fn(async () => {}), vi.fn())
  const load = vi.fn().mockImplementationOnce(async () => { await gate.promise; return old }).mockResolvedValue(fresh)
  const host = createRuntimeHost(load)
  const initial = host.start(); host.stop(); await host.start(); gate.resolve(); await initial
  expect(old.phase.value).toBe('stopped')
  expect(currentRuntime.value).toBe(fresh)
  host.stop()
  expect(currentRuntime.value).toBeNull()
})
it('deduplicates host start and stops only its own runtime', async () => {
  const runtime = createRuntime('web', async () => {}, vi.fn())
  const host = createRuntimeHost(async () => runtime)
  const start = host.start(); expect(host.start()).toBe(start); await start
  const unrelated = createRuntime('desktop', async () => {}, vi.fn())
  currentRuntime.value = unrelated
  host.stop()
  expect(currentRuntime.value).toBe(unrelated)
})
it('contains a factory failure so the UI can still mount', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const host = createRuntimeHost(async () => { throw new Error('factory') })
  await host.start()
  expect(currentRuntime.value).toBeNull()
  expect(log).toHaveBeenCalledOnce()
  host.stop()
})
it('never waits for web bootstrap', async () => { await waitForPlatform(deferred().promise, 0) })
it('bounds desktop bootstrap without cancelling pending initialization', async () => {
  vi.useFakeTimers()
  const gate = deferred(), complete = vi.fn()
  const start = waitForPlatform(gate.promise.then(complete), 4000)
  await vi.advanceTimersByTimeAsync(4000); await start
  expect(complete).not.toHaveBeenCalled()
  gate.resolve(); await Promise.resolve()
  expect(complete).toHaveBeenCalledOnce()
})
it('clears the desktop budget timer when initialization finishes early', async () => {
  vi.useFakeTimers()
  await waitForPlatform(Promise.resolve(), 4000)
  expect(vi.getTimerCount()).toBe(0)
})
