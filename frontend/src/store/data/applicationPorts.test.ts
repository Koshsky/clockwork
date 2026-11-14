import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopBridge, DesktopServiceState } from '@/data/desktopBridge'
const session = vi.hoisted(() => ({ value: { contextId: 'session-a' } as { contextId: string } | null }))
vi.mock('@/session/desktop', () => ({ desktopSessionState: session }))
vi.mock('./adapters/httpPorts', () => ({ createHttpPorts: vi.fn(() => ({ reads: { read: vi.fn() }, commands: { execute: vi.fn() } })) }))
import { applicationPorts, stopApplicationPorts } from './applicationPorts'
import { desktopDataState, observeDesktopState } from '@/data/desktopState'
import { createHttpPorts } from './adapters/httpPorts'
const snapshot = (contextId = 'session-a', revision = 1): DesktopServiceState => ({ protocol: 1, profileId: 'test', instanceId: 'instance', version: 'test', electron: 'test', phase: 'ready', revision, running: 0, capabilities: { reads: [], commands: [] }, context: { id: 'service-context-' + contextId, server: 'https://fixture.test/api/v1', accountId: 7 }, queue: { contextId, running: false, revision } })
const bridge = { businessProtocol: 1, status: vi.fn<DesktopBridge['status']>(), read: vi.fn<DesktopBridge['read']>(), execute: vi.fn<DesktopBridge['execute']>(), cancel: vi.fn<DesktopBridge['cancel']>(), subscribe: vi.fn<DesktopBridge['subscribe']>() }
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => {
  stopApplicationPorts(); vi.clearAllMocks(); session.value = { contextId: 'session-a' }
  vi.stubGlobal('window', { erpDesktop: { service: bridge } })
  bridge.status.mockResolvedValue(snapshot()); bridge.subscribe.mockReturnValue(vi.fn())
  bridge.read.mockResolvedValue({ status: 'ok', source: 'snapshot', data: {} })
  bridge.execute.mockResolvedValue({ status: 'queued', operationId: 'stable-key' })
})
afterEach(() => { stopApplicationPorts(); vi.unstubAllGlobals() })
it('selects web HTTP synchronously and never initializes IPC', () => {
  vi.stubGlobal('window', {})
  expect(applicationPorts()).not.toBeInstanceOf(Promise)
  expect(createHttpPorts).toHaveBeenCalledOnce(); expect(bridge.status).not.toHaveBeenCalled()
})
it('shares one desktop subscription and never falls back to HTTP', async () => {
  const [first, second] = await Promise.all([applicationPorts(), applicationPorts()])
  expect(bridge.status).toHaveBeenCalledOnce(); expect(bridge.subscribe).toHaveBeenCalledOnce()
  await first.reads.read('planning.tasks', undefined, { source: 'snapshot' })
  await second.commands.execute('task.delete', { id: 1 }, { operationId: 'stable-key' })
  expect(bridge.read).toHaveBeenCalledWith(expect.objectContaining({ contextId: 'service-context-session-a', source: 'snapshot' }))
  expect(createHttpPorts).not.toHaveBeenCalled()
})
it('does not borrow a new login context while initial status is pending', async () => {
  const held = defer<DesktopServiceState>(); bridge.status.mockReturnValue(held.promise)
  const pending = applicationPorts(); session.value = { contextId: 'session-b' }; held.resolve(snapshot('session-b'))
  const ports = await pending
  expect((await ports.reads.read('planning.tasks', undefined, { source: 'refresh' })).status).toBe('cancelled')
  expect(await ports.commands.execute('task.delete', { id: 1 }, { operationId: 'stable-key' })).toMatchObject({ status: 'unknown', operationId: 'stable-key' })
  expect(bridge.read).not.toHaveBeenCalled(); expect(bridge.execute).not.toHaveBeenCalled()
})
it('rejects an old read after logout and same-account login', async () => {
  const ports = await applicationPorts(), held = defer<Awaited<ReturnType<DesktopBridge['read']>>>()
  bridge.read.mockReturnValue(held.promise)
  const pending = ports.reads.read('planning.tasks', undefined, { source: 'refresh' })
  session.value = { contextId: 'session-b' }; observeDesktopState(snapshot('session-b', 2))
  held.resolve({ status: 'ok', data: {}, source: 'refresh' })
  expect((await pending).status).toBe('cancelled')
})
it('reports an old command as unknown with its stable key instead of accepting it in a new session', async () => {
  const ports = await applicationPorts(), held = defer<Awaited<ReturnType<DesktopBridge['execute']>>>()
  bridge.execute.mockReturnValue(held.promise)
  const pending = ports.commands.execute('task.delete', { id: 1 }, { operationId: 'stable-key' })
  session.value = { contextId: 'session-b' }; held.resolve({ status: 'confirmed', data: null })
  expect(await pending).toMatchObject({ status: 'unknown', operationId: 'stable-key' })
})
it('disposed initialization cannot reinstall a stale service context', async () => {
  const held = defer<DesktopServiceState>(); bridge.status.mockReturnValueOnce(held.promise)
  const pending = applicationPorts(); stopApplicationPorts(); held.resolve(snapshot())
  const old = await pending
  expect(desktopDataState.value).toBeNull()
  expect((await old.reads.read('planning.tasks', undefined, { source: 'refresh' })).status).toBe('cancelled')
  await applicationPorts(); expect(bridge.subscribe).toHaveBeenCalledTimes(2)
})
it('an unavailable native service settles with failure and never uses renderer HTTP', async () => {
  bridge.status.mockRejectedValue(new Error('Service unavailable'))
  await expect(applicationPorts()).rejects.toThrow('Service unavailable')
  expect(createHttpPorts).not.toHaveBeenCalled()
})
it('late status snapshots cannot replace a newer service event', () => {
  observeDesktopState(snapshot('session-b', 2)); observeDesktopState(snapshot('session-a', 1))
  expect(desktopDataState.value?.queue?.contextId).toBe('session-b')
})
