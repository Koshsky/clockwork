import axios, { AxiosError, CanceledError, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), byPath: vi.fn(), replay: vi.fn(), offline: { value: false }, token: 'test' }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'web', optionalStorage: true } }))
vi.mock('./router', () => ({ default: { currentRoute: { value: { name: 'planner', fullPath: '/planner' } }, push: vi.fn() } }))
vi.mock('./offline/cache', () => ({ cachePut: fake.put, cacheGet: fake.get, cacheGetByPath: fake.byPath, userCachePrefix: () => 'u7:' }))
vi.mock('./offline/outbox', () => ({ replayOutboxToCache: fake.replay, scheduleReplayOutboxToCache: fake.replay, createMutationKey: () => 'key' }))
vi.mock('./offline/state', () => ({ isOffline: fake.offline }))
vi.mock('./offline/sync', () => ({ ensureAutoSession: async () => false }))
vi.mock('./loggedOut', () => ({ isLoggedOut: () => false }))
vi.mock('./token', () => ({ getAccessToken: () => fake.token, accessTokenExpired: () => false }))
import { setupHttp } from './http'
import { hasActiveMutations } from './offline/mutationGuard'
import { legacyQueueAvailability } from './platform/state'
const adapter = axios.defaults.adapter
beforeEach(() => {
  vi.resetAllMocks(); fake.offline.value = false; legacyQueueAvailability.value = 'empty'
  fake.get.mockResolvedValue(null); fake.put.mockResolvedValue(undefined)
  axios.interceptors.request.clear(); axios.interceptors.response.clear(); setupHttp()
})
afterEach(() => { axios.defaults.adapter = adapter; axios.interceptors.request.clear(); axios.interceptors.response.clear() })
it('returns web API data without waiting for optional disk persistence', async () => {
  fake.put.mockReturnValue(new Promise(() => {}))
  axios.defaults.adapter = async config => ({ data: { data: [1] }, status: 200, statusText: 'OK', headers: {}, config })
  expect((await axios.get('/api/v1/project')).data).toEqual({ data: [1] })
  expect(fake.replay).not.toHaveBeenCalled()
})
it('does not fallback to a different filter or page after an exact cache miss', async () => {
  axios.defaults.adapter = async config => { throw new AxiosError('Network Error', 'ERR_NETWORK', config) }
  fake.byPath.mockResolvedValue({ data: { items: [{ id: 8, owner_id: 99 }] } })
  await expect(axios.get('/api/v1/resources', { params: { owner_id: 7, offset: 500 } })).rejects.toThrow('Network Error')
  expect(fake.byPath).not.toHaveBeenCalled(); expect(fake.replay).not.toHaveBeenCalled()
  expect(fake.offline.value).toBe(true)
})
it('returns an exact in-memory snapshot on a real network failure', async () => {
  fake.get.mockResolvedValue({ data: [1] })
  axios.defaults.adapter = async config => { throw new AxiosError('Network Error', 'ERR_NETWORK', config) }
  expect((await axios.get('/api/v1/project')).data).toEqual({ data: [1] })
  expect(fake.offline.value).toBe(true)
})
it('does not turn a cancelled GET into cached success or an offline transition', async () => {
  fake.get.mockResolvedValue({ data: [1] })
  axios.defaults.adapter = async config => { throw new CanceledError('cancelled', config) }
  await expect(axios.get('/api/v1/project')).rejects.toBeInstanceOf(CanceledError)
  expect(fake.get).not.toHaveBeenCalled(); expect(fake.offline.value).toBe(false)
})
it('recognizes a successful web read as recovery even if automatic synchronization is off', async () => {
  fake.offline.value = true
  axios.defaults.adapter = async config => ({ data: { data: [] }, status: 200, statusText: 'OK', headers: {}, config })
  await axios.get('/api/v1/project')
  expect(fake.offline.value).toBe(false)
})
it('recognizes an actual unauthorized response before attempting session recovery', async () => {
  fake.offline.value = true
  axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => { throw new AxiosError('Unauthorized', undefined, config, undefined, { data: {}, status: 401, statusText: 'Unauthorized', headers: {}, config }) }
  await expect(axios.get('/api/v1/project')).rejects.toThrow()
  expect(fake.offline.value).toBe(false)
})

it.each(['confirmed', 'failed', 'cancelled'])('releases the HTTP mutation guard after a %s administration write', async mode => {
  axios.defaults.adapter = async config => {
    expect(hasActiveMutations()).toBe(true)
    if (mode === 'failed') throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    if (mode === 'cancelled') throw new CanceledError('cancelled', config)
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
  }
  if (mode === 'confirmed') await axios.put('/api/v1/user/7', {})
  else await expect(axios.put('/api/v1/user/7', {})).rejects.toThrow()
  expect(hasActiveMutations()).toBe(false)
})
