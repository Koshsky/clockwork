import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop', optionalStorage: false } }))
import { beginMutation } from './offline/mutationGuard'

const mocks = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), byPath: vi.fn(), replay: vi.fn(), scheduledReplay: vi.fn(), offline: { value: false }, loggedOut: false, renew: vi.fn(), token: 'test-token', expired: false, prefix: 'u51:' }))
vi.mock('./router', () => ({ default: { currentRoute: { value: { name: 'planner', fullPath: '/planner' } }, push: vi.fn() } }))
vi.mock('./offline/cache', () => ({ cachePut: mocks.put, cacheGet: mocks.get, cacheGetByPath: mocks.byPath, userCachePrefix: () => mocks.prefix }))
vi.mock('./offline/outbox', () => ({ replayOutboxToCache: mocks.replay, scheduleReplayOutboxToCache: mocks.scheduledReplay, createMutationKey: () => crypto.randomUUID() }))
vi.mock('./offline/state', () => ({ isOffline: mocks.offline }))
vi.mock('./offline/sync', () => ({ ensureAutoSession: mocks.renew }))
vi.mock('./loggedOut', () => ({ isLoggedOut: () => mocks.loggedOut }))
vi.mock('./token', () => ({ getAccessToken: () => mocks.token, accessTokenExpired: () => mocks.expired }))
import { setupHttp } from './http'
import router from './router'

const adapter = axios.defaults.adapter
beforeEach(() => {
  vi.clearAllMocks()
  mocks.offline.value = false
  mocks.loggedOut = false
  mocks.token = 'test-token'
  mocks.expired = false
  mocks.prefix = 'u51:'
  mocks.get.mockResolvedValue(null)
  mocks.byPath.mockResolvedValue(null)
  axios.interceptors.request.clear()
  axios.interceptors.response.clear()
  setupHttp()
})
afterEach(() => {
  axios.defaults.adapter = adapter
  axios.interceptors.request.clear()
  axios.interceptors.response.clear()
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

it.each(['', 'Bearer previous'])('reuses a restored token for a delayed 401 sent with %j', async authorization => {
  const sent: unknown[] = []
  axios.defaults.adapter = async config => {
    sent.push(config.headers.get('Authorization'))
    if (sent.length === 1) throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { config, status: 401, statusText: 'Unauthorized', headers: {}, data: {} })
    return { status: 200, statusText: 'OK', headers: {}, config, data: {} }
  }
  await axios.get('/api/v1/planning/tasks', { headers: { Authorization: authorization } })
  expect(sent).toEqual([authorization, 'Bearer test-token'])
  expect(mocks.renew).not.toHaveBeenCalled()
})

it.each(['current', 'expired'])('renews a rejected %s token instead of blindly retrying', async kind => {
  mocks.expired = kind === 'expired'
  mocks.renew.mockImplementation(async () => { mocks.token = 'renewed'; mocks.expired = false; return true })
  let calls = 0
  axios.defaults.adapter = async config => {
    if (++calls === 1) throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { config, status: 401, statusText: 'Unauthorized', headers: {}, data: {} })
    return { status: 200, statusText: 'OK', headers: {}, config, data: {} }
  }
  await axios.get('/api/v1/planning/tasks', { headers: { Authorization: kind === 'expired' ? 'Bearer old' : 'Bearer test-token' } })
  expect(mocks.renew).toHaveBeenCalledTimes(1)
  expect(calls).toBe(2)
})

describe('offline cache and in-flight read safety', () => {
  it('stores a clean successful read under the current user cache key', async () => {
    const body = { data: { processes: [] } }
    axios.defaults.adapter = async (config) => ({ status: 200, statusText: 'OK', headers: {}, config, data: body })
    await axios.get('/api/v1/planning/tasks')
    expect(mocks.put).toHaveBeenCalledExactlyOnceWith('u51:/api/v1/planning/tasks', body)
    expect(mocks.scheduledReplay).toHaveBeenCalledTimes(1)
  })
  it.each(['before', 'during'])('does not cache a GET started %s an unconfirmed mutation', async (when) => {
    let finish = when === 'during' ? beginMutation() : () => {}
    let reply!: () => void
    axios.defaults.adapter = (config) => new Promise<AxiosResponse>((resolve) => {
      reply = () => resolve({ status: 200, statusText: 'OK', headers: {}, config, data: { data: 'old' } })
    })
    try {
      const read = axios.get('/api/v1/planning/tasks')
      await tick()
      if (when === 'before') finish = beginMutation()
      finish()
      reply()
      await read
      expect(mocks.put).not.toHaveBeenCalled()
    } finally { finish() }
  })
  it('serves the preserved cache during a network failure, then refreshes it on recovery', async () => {
    const cached = { data: { processes: [{ id: 1 }] } }
    mocks.get.mockResolvedValue(cached)
    axios.defaults.adapter = async (config) => { throw new AxiosError('Network Error', 'ERR_NETWORK', config) }
    const response = await axios.get('/api/v1/planning/tasks')
    expect(response.data).toEqual(cached)
    expect(response).toHaveProperty('__erpLocalSnapshot', true)
    expect(mocks.offline.value).toBe(true)
    expect(mocks.replay).toHaveBeenCalledTimes(1)
    expect(mocks.put).not.toHaveBeenCalled()
    mocks.offline.value = false
    const fresh = { data: { processes: [{ id: 2 }] } }
    axios.defaults.adapter = async (config) => ({ status: 200, statusText: 'OK', headers: {}, config, data: fresh })
    await axios.get('/api/v1/planning/tasks')
    expect(mocks.put).toHaveBeenCalledExactlyOnceWith('u51:/api/v1/planning/tasks', fresh)
  })

  it('does not cache a previous account response after account switching', async () => {
    let reply!: () => void
    axios.defaults.adapter = config => new Promise<AxiosResponse>(resolve => {
      reply = () => resolve({ status: 200, statusText: 'OK', headers: {}, config, data: { data: 'previous user data' } })
    })
    const pending = axios.get('/api/v1/planning/tasks')
    await tick()
    mocks.prefix = 'u52:'
    reply()
    await pending
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.scheduledReplay).not.toHaveBeenCalled()
  })

  it('does not read the new account cache for an older failed request', async () => {
    axios.defaults.adapter = async config => {
      mocks.prefix = 'u52:'
      throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    }
    await expect(axios.get('/api/v1/planning/tasks')).rejects.toThrow('Network Error')
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.byPath).not.toHaveBeenCalled()
  })

  it('does not deliver cached data if the account changes during lookup', async () => {
    mocks.get.mockImplementationOnce(async () => {
      mocks.prefix = 'u52:'
      return { data: 'previous user data' }
    })
    axios.defaults.adapter = async config => { throw new AxiosError('Network Error', 'ERR_NETWORK', config) }
    await expect(axios.get('/api/v1/planning/tasks')).rejects.toThrow('Network Error')
    expect(mocks.offline.value).toBe(false)
  })

  it('does not refresh another account because an older GET returned 401', async () => {
    axios.defaults.adapter = async config => {
      mocks.prefix = 'u52:'
      throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { config, status: 401, statusText: 'Unauthorized', headers: {}, data: {} })
    }
    await expect(axios.get('/api/v1/planning/tasks')).rejects.toMatchObject({ response: { status: 401 } })
    expect(mocks.renew).not.toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })
})

it('assigns an idempotency key before the first mutation and preserves it on retry', async () => {
  const keys: unknown[] = []
  axios.defaults.adapter = async (config) => {
    keys.push(config.headers.get('Idempotency-Key'))
    return { status: 200, statusText: 'OK', headers: {}, config, data: {} }
  }
  await axios.post('/api/v1/task', { title: 'Offline P0' })
  expect(keys[0]).toBeTruthy()
  await axios.post('/api/v1/task', { title: 'Offline P0' }, { headers: { 'Idempotency-Key': keys[0] as string } })
  expect(keys[1]).toBe(keys[0])
})

it('never stores a subject preview in the normal offline cache', async () => {
  axios.defaults.adapter = async (config) => ({ status: 200, statusText: 'OK', headers: {}, config, data: { data: 'subject only' } })
  await axios.get('/api/v1/planning/tasks', { headers: { 'X-View-User-ID': '7' } })
  expect(mocks.put).not.toHaveBeenCalled()
})
it('never serves an administrator cache as a subject preview on a network failure', async () => {
  mocks.get.mockResolvedValue({ data: 'whole system' })
  axios.defaults.adapter = async (config) => { throw new AxiosError('Network Error', 'ERR_NETWORK', config) }
  await expect(axios.get('/api/v1/planning/tasks', { headers: { 'X-View-User-ID': '7' } })).rejects.toThrow()
  expect(mocks.get).not.toHaveBeenCalled()
})


it.each(['projects', 'processes', 'tasks'])('clears stale online auth before redirecting a logged-out %s request', async entity => {
  mocks.loggedOut = true
  mocks.renew.mockResolvedValue(false)
  const send = vi.fn(async (config: InternalAxiosRequestConfig) => {
    throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { config, status: 401, statusText: 'Unauthorized', headers: {}, data: {} })
  })
  axios.defaults.adapter = send

  await expect(axios.get('/api/v1/planning/' + entity)).rejects.toMatchObject({ response: { status: 401 } })

  expect(mocks.renew).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
  expect(router.push).toHaveBeenCalledWith({ name: 'login', query: { redirect: '/planner' } })
})
