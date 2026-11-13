import { afterEach, expect, it, vi } from 'vitest'
import { Configuration } from '@/api'
import type { InternalAxiosRequestConfig } from 'axios'
import { optionalCachePut, optionalCacheGet, optionalCacheKeys, optionalCacheClear } from './cacheStore'
import * as storage from './db'
import * as queue from './outbox'
import { desktopSession, desktopSessionState, prepareDesktopSession } from './session'
import { nativeQueue, nativeSync, queueRequest } from './desktopQueue'
import { applicationPorts, nativeBusinessPorts, stopApplicationPorts } from './applicationPorts'
import { platformCapabilities } from './context'

afterEach(async () => { await optionalCacheClear('cache'); stopApplicationPorts(); vi.unstubAllGlobals() })
it('keeps a genuinely absent memory snapshot distinct from an empty successful list', async () => {
  expect(await optionalCacheGet('cache', 'missing')).toBeUndefined()
  await optionalCachePut('cache', 'empty', [])
  expect(await optionalCacheGet('cache', 'empty')).toEqual([])
})
it('memory snapshots cannot be mutated through input or output references', async () => {
  const data = { items: [{ id: 1 }] }
  await optionalCachePut('cache', 'server-a:account-1', data); data.items[0].id = 2
  const first = await optionalCacheGet<typeof data>('cache', 'server-a:account-1'); first!.items[0].id = 3
  expect(await optionalCacheGet('cache', 'server-a:account-1')).toEqual({ items: [{ id: 1 }] })
  expect(await optionalCacheGet('cache', 'server-b:account-1')).toBeUndefined()
})
it('clearing disposable cache neither discovers nor touches an old IndexedDB profile', async () => {
  const open = vi.fn(), databases = vi.fn(), deleteDatabase = vi.fn()
  vi.stubGlobal('indexedDB', { open, databases, deleteDatabase })
  await optionalCachePut('cache', 'entry', {}); expect(await optionalCacheKeys('cache')).toEqual(['entry'])
  await optionalCacheClear('cache'); expect(await optionalCacheKeys('cache')).toEqual([])
  expect(open).not.toHaveBeenCalled(); expect(databases).not.toHaveBeenCalled(); expect(deleteDatabase).not.toHaveBeenCalled()
})
it('every legacy IndexedDB entry point refuses access instead of silently adopting data', async () => {
  for (const action of [() => storage.idbGet('session', 'refresh'), () => storage.idbPut('outbox', 'key', {}), () => storage.idbAll('outbox'), () => storage.idbKeys('cache'), () => storage.idbCount('outbox'), () => storage.idbDel('outbox', 'key'), () => storage.idbClear('outbox')]) await expect(action()).rejects.toThrow('WEB_OFFLINE_STORAGE_UNAVAILABLE')
})
it('web mutations cannot turn an offline write into a durable or apparently queued result', async () => {
  await expect(queue.enqueueMutation({ entity: 'task', method: 'PUT', url: '/task/1', body: { title: 'unsent' } })).rejects.toThrow('WEB_OFFLINE_QUEUE_UNAVAILABLE')
  expect(queue.pendingCount.value).toBe(0); expect(queue.pendingRefs.value.size).toBe(0)
  expect((await queue.flushOutbox()).ok).toBe(0)
})
it('legacy cleanup and retry controls never delete or replay an existing browser queue', async () => {
  const open = vi.fn(); vi.stubGlobal('indexedDB', { open })
  await queue.clearOutbox(); await queue.pruneForeignOutbox('another-user'); await queue.discardFailed(); await queue.resetFailedRetries(); await queue.replayOutboxToCache(); await queue.refreshPendingCount()
  expect(open).not.toHaveBeenCalled(); expect(await queue.getFailedEntries()).toEqual([])
})
it('an injected desktop-looking object cannot enable native capabilities in a web artifact', async () => {
  const invoke = vi.fn(); vi.stubGlobal('window', { erpDesktop: { isElectron: true, session: { status: invoke }, service: { businessProtocol: 1, status: invoke }, queue: { request: invoke } } })
  expect(platformCapabilities.kind).toBe('web'); expect(platformCapabilities.offlineBootstrap).toBe(false)
  expect(desktopSession).toBeUndefined(); expect(desktopSessionState.value).toBeNull(); expect(nativeQueue).toBeUndefined(); expect(nativeSync).toBe(false)
  expect(nativeBusinessPorts()).toBe(false)
  await expect(prepareDesktopSession()).rejects.toThrow('WEB_DESKTOP_SESSION_UNAVAILABLE')
  await expect(queueRequest({ action: 'push' })).rejects.toThrow('WEB_OFFLINE_QUEUE_UNAVAILABLE')
  expect(invoke).not.toHaveBeenCalled()
})
it('the web composition keeps generated HTTP reads and stable-key commands available', async () => {
  const requests: InternalAxiosRequestConfig[] = []
  const configuration = () => new Configuration({ basePath: 'https://fixture.test/api/v1', baseOptions: { adapter: async (config: InternalAxiosRequestConfig) => { requests.push(config); return { status: 200, statusText: 'OK', headers: {}, config, data: { data: { id: 1 }, error: {} } } } } })
  const ports = applicationPorts(configuration)
  expect((await ports.reads.read('planning.tasks', undefined, { source: 'refresh' })).status).toBe('ok')
  expect(await ports.commands.execute('task.update', { id: 1, patch: { title: 'Online' } }, { operationId: 'stable-key' })).toMatchObject({ status: 'confirmed', operationId: 'stable-key' })
  expect(requests).toHaveLength(2); expect(requests[1].headers.get('Idempotency-Key')).toBe('stable-key')
})
