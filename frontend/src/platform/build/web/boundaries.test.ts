import { afterEach, expect, it, vi } from 'vitest'
import { Configuration } from '@/api'
import type { InternalAxiosRequestConfig } from 'axios'
import * as cache from './cacheStore'
import { webOfflineContract } from '../../../../tests/contracts/webOffline'
import * as storage from './db'
import * as queue from './outbox'
import { desktopSession, desktopSessionState, prepareDesktopSession } from './session'
import { nativeQueue, nativeSync, queueRequest } from './desktopQueue'
import { applicationPorts, nativeBusinessPorts, stopApplicationPorts } from './applicationPorts'
import { platformCapabilities } from './context'

afterEach(async () => { await cache.optionalCacheClear('cache'); stopApplicationPorts(); vi.unstubAllGlobals() })
webOfflineContract('production web composition', { cache, queue })
it('every legacy IndexedDB entry point refuses access instead of silently adopting data', async () => {
  for (const action of [() => storage.idbGet('session', 'refresh'), () => storage.idbPut('outbox', 'key', {}), () => storage.idbAll('outbox'), () => storage.idbKeys('cache'), () => storage.idbCount('outbox'), () => storage.idbDel('outbox', 'key'), () => storage.idbClear('outbox')]) await expect(action()).rejects.toThrow('WEB_OFFLINE_STORAGE_UNAVAILABLE')
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
