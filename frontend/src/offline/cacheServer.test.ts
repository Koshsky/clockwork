import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ session: { mode: 'online', user: { id: 7, username: 'verified' } }, server: 'https://first.example/api/v1', entries: new Map<string, unknown>() }))
vi.mock('@/session/desktop', () => ({ desktopSession: {}, desktopSessionState: { get value() { return fixture.session } } }))
vi.mock('@/config', () => ({ getApiUrl: () => fixture.server }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop' } }))
vi.mock('@/platform/cacheStore', () => ({
  optionalCacheGet: async (_store: string, key: string) => fixture.entries.get(key),
  optionalCacheKeys: async () => [...fixture.entries.keys()],
  optionalCachePut: vi.fn(), optionalCacheClear: vi.fn(),
}))
import { cacheGetByPath, cacheGetFresh, cacheGetAllByPath, currentUserId } from './cache'
beforeEach(() => {
  fixture.server = 'https://first.example/api/v1'
  fixture.entries.clear()
  fixture.session.mode = 'online'
  vi.stubGlobal('localStorage', { getItem: () => '{"id":7}' })
  fixture.entries.set('u7:https://first.example/api/v1/project?offset=0', { ts: 1, data: 'first-server' })
  fixture.entries.set('u7:https://second.example/api/v1/project?offset=0', { ts: 100, data: 'second-server' })
  fixture.entries.set('u8:https://first.example/api/v1/project?offset=0', { ts: 200, data: 'another-user' })
})
afterEach(() => vi.unstubAllGlobals())
it('hydrates only the selected server even if another server has newer data with the same user id', async () => {
  expect(await cacheGetByPath('/api/v1/project')).toBe('first-server')
  expect(await cacheGetFresh('/api/v1/project')).toEqual({ ts: 1, data: 'first-server' })
  expect((await cacheGetAllByPath('/api/v1/project')).map(item => item.data)).toEqual(['first-server'])
})
it('server selection isolates cached pages without deleting another server or account data', async () => {
  fixture.server = 'https://second.example/api/v1'
  expect(await cacheGetByPath('/api/v1/project')).toBe('second-server')
  expect(fixture.entries.size).toBe(3)
})
it('refuses an unconfigured server and legacy relative cache keys whose server identity is unknown', async () => {
  fixture.entries.set('u7:/api/v1/project', { ts: 999, data: 'unscoped' })
  expect(await cacheGetByPath('/api/v1/project')).toBe('first-server')
  fixture.server = ''
  expect(await cacheGetFresh('/api/v1/project')).toBeNull()
})

it('uses the main identity even when cached metadata is edited or localStorage fails', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{"id":1,"username":"admin"}' })
  expect(currentUserId()).toBe(7)
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') } })
  expect(currentUserId()).toBe(7)
  fixture.session.mode = 'signedOut'
  expect(currentUserId()).toBeNull()
})
