import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { Configuration, type DtoTaskPlanning, type DtoTaskResponse } from '@/api'
import { isOffline } from '@/offline/state'
import { hasActiveMutations } from '@/offline/mutationGuard'
import { taskDataContract, type TaskDataFixture } from '../../../tests/contracts/taskData'
import { createLegacyTaskData } from './legacyTasks'
import { runLegacyMutation, runMutation } from './legacyMutation'

const fake = vi.hoisted(() => ({
  snapshot: null as unknown,
  hydrate: vi.fn(),
  enqueue: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('@/offline/hydrate', () => ({
  apiPath: (path: string) => '/api/v1' + path,
  hydrateFromCache: async (targets: Array<{ apply: (body: unknown) => void }>) => {
    fake.hydrate()
    if (fake.snapshot != null) targets[0]!.apply({ data: fake.snapshot })
  },
}))
vi.mock('@/offline/outbox', () => ({
  enqueueMutation: fake.enqueue,
  isNetworkError: (error: AxiosError) => !error.response && error.code === 'ERR_NETWORK',
}))
vi.mock('@/offline/sync', () => ({ scheduleDomainRefresh: fake.refresh }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(): TaskDataFixture & { calls: InternalAxiosRequestConfig[] } {
  const calls: InternalAxiosRequestConfig[] = []
  let planning: DtoTaskPlanning | null = { processes: [] }
  let updated: DtoTaskResponse | null = { id: 7 }
  let readFailure: { status: number; code?: string } | null = null
  let writeFailure: { status: number; code?: string } | null = null
  let offline = false
  let hold: ReturnType<typeof deferred> | null = null
  const adapter: AxiosAdapter = async (config) => {
    calls.push(config)
    if (config.method === 'get' && hold) await hold.promise
    if (offline) throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    const failure = config.method === 'get' ? readFailure : writeFailure
    const response = {
      config, status: failure?.status ?? 200, statusText: '', headers: {},
      data: failure ? { error: { code: failure.code, message: 'Server refusal' } } : { data: config.method === 'get' ? planning : updated },
    }
    if (failure && failure.status >= 400) throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, undefined, response)
    return response
  }
  return {
    port: createLegacyTaskData(() => new Configuration({ basePath: 'http://local.test/api/v1', baseOptions: { adapter } })),
    calls,
    planning: (data) => { planning = data },
    snapshot: (data) => { fake.snapshot = data },
    updated: (data) => { updated = data },
    failRead: (status, code) => { readFailure = { status, code } },
    failUpdate: (status, code) => { writeFailure = { status, code } },
    offline: () => { offline = true },
    readCount: () => calls.filter((c) => c.method === 'get').length,
    queuedCount: () => fake.enqueue.mock.calls.length,
    holdRead: () => { hold = deferred(); return hold.resolve },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fake.snapshot = null
  fake.enqueue.mockResolvedValue(undefined)
  isOffline.value = false
})
afterEach(() => {
  expect(hasActiveMutations()).toBe(false)
  isOffline.value = false
})

taskDataContract('Legacy adapter with generated API client', fixture, { offlineWrites: true })

describe('legacy task adapter compatibility', () => {
  it('hydrates a warmed snapshot without issuing HTTP', async () => {
    const f = fixture()
    f.snapshot({ processes: [{ id: 10 }] })
    expect(await f.port.readPlanning({ source: 'snapshot' })).toEqual({ status: 'ok', data: { processes: [{ id: 10 }] }, source: 'snapshot' })
    expect(f.readCount()).toBe(0)
    expect(fake.hydrate).toHaveBeenCalledOnce()
  })

  it('keeps an uncached payload missing, including a null HTTP payload', async () => {
    const f = fixture()
    f.planning(null)
    expect(await f.port.readPlanning({ source: 'refresh' })).toEqual({ status: 'missing' })
  })

  it.each(['refresh', 'snapshot'] as const)('cancels %s before touching data', async (source) => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await f.port.readPlanning({ source, signal: controller.signal })).toEqual({ status: 'cancelled' })
    expect(fake.hydrate).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('passes read cancellation to the generated client', async () => {
    const f = fixture()
    const controller = new AbortController()
    await f.port.readPlanning({ source: 'refresh', signal: controller.signal })
    expect(f.calls[0]!.signal).toBe(controller.signal)
  })

  it('does not label an HTTP cache fallback as refreshed server data', async () => {
    const interceptor = axios.interceptors.response.use((response) => Object.assign(response, { __erpLocalSnapshot: true }))
    try {
      const f = fixture()
      expect(await f.port.readPlanning({ source: 'refresh' })).toMatchObject({ status: 'ok', source: 'snapshot' })
    } finally {
      axios.interceptors.response.eject(interceptor)
    }
  })

  it('returns the operation identity when storage fails after a lost response', async () => {
    const f = fixture()
    f.offline()
    fake.enqueue.mockRejectedValueOnce(new Error('Disk full'))
    expect(await f.port.update(7, { title: 'Pending' }, { operationId: 'lost-response-key' })).toMatchObject({
      status: 'unknown', operationId: 'lost-response-key', error: { kind: 'storage', message: 'Disk full' },
    })
  })

  it.each(['read', 'write'] as const)('rejects an HTTP 200 domain error on %s', async (operation) => {
    const f = fixture()
    if (operation === 'read') {
      f.failRead(200, 'FORBIDDEN')
      expect(await f.port.readPlanning({ source: 'refresh' })).toMatchObject({ status: 'failed', error: { kind: 'forbidden', code: 'FORBIDDEN' } })
    } else {
      f.failUpdate(200, 'CONFLICT')
      expect(await f.port.update(7, { title: 'Changed' })).toMatchObject({ status: 'conflict', error: { kind: 'conflict', code: 'CONFLICT' } })
      expect(fake.enqueue).not.toHaveBeenCalled()
    }
  })

  it('does not claim queued until persistence completes', async () => {
    const f = fixture()
    f.offline()
    const hold = deferred()
    fake.enqueue.mockReturnValueOnce(hold.promise)
    let settled = false
    const pending = f.port.update(7, { title: 'Offline' }).then((result) => { settled = true; return result })
    await vi.waitFor(() => expect(fake.enqueue).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    expect(hasActiveMutations()).toBe(true)
    hold.resolve()
    expect(await pending).toEqual({ status: 'queued' })
    expect(fake.refresh).not.toHaveBeenCalled()
  })

  it('does not claim saved when persistent storage rejects the command', async () => {
    const f = fixture()
    f.offline()
    fake.enqueue.mockRejectedValueOnce(new Error('Disk full'))
    expect(await f.port.update(7, { title: 'Offline' })).toMatchObject({ status: 'unknown', error: { kind: 'storage' } })
  })

  it('keeps the original operation key and payload when the response is lost', async () => {
    const f = fixture()
    f.offline()
    const patch = { title: '<script>untrusted</script>', start_date: '2026-11-12' }
    expect(await f.port.update(7, patch, { operationId: 'original-operation' })).toEqual({ status: 'queued', operationId: 'original-operation' })
    expect(fake.enqueue).toHaveBeenCalledWith({
      entity: 'task', tempId: undefined, method: 'put', url: 'http://local.test/api/v1/task/7',
      body: JSON.stringify(patch), idempotencyKey: 'original-operation',
    })
    expect(f.calls[0]!.headers.get('Idempotency-Key')).toBe('original-operation')
  })

  it('schedules the existing domain refresh only after online confirmation', async () => {
    const f = fixture()
    await f.port.update(7, { title: 'Changed' })
    expect(fake.refresh).toHaveBeenCalledExactlyOnceWith(['task'])
    isOffline.value = true
    await f.port.update(7, { title: 'Changed again' })
    expect(fake.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('legacy mutation compatibility wrapper', () => {
  const options = () => ({ entity: 'task' as const, call: vi.fn(), apply: vi.fn(), optimistic: vi.fn(), onError: vi.fn() })

  it('unwraps exactly two envelope levels and ignores an empty error object', async () => {
    const opts = options()
    opts.call.mockResolvedValue({ data: { data: { id: 7 }, error: {} } })
    expect(await runMutation(opts)).toBe(true)
    expect(opts.apply).toHaveBeenCalledExactlyOnceWith({ id: 7 })
    expect(opts.optimistic).not.toHaveBeenCalled()
  })

  it('preserves the legacy boolean for queued changes and applies only after enqueue', async () => {
    const opts = options()
    opts.call.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK', { headers: new AxiosHeaders(), method: 'put', url: '/task/7' }))
    fake.enqueue.mockImplementationOnce(async () => { expect(opts.optimistic).not.toHaveBeenCalled() })
    expect(await runMutation(opts)).toBe(true)
    expect(opts.optimistic).toHaveBeenCalledOnce()
    expect(opts.apply).not.toHaveBeenCalled()
  })

  it('never queues a second write because local apply failed after acknowledgement', async () => {
    const opts = options()
    opts.call.mockResolvedValue({ data: { data: { id: 7 } } })
    opts.apply.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK', { headers: new AxiosHeaders(), method: 'put', url: '/task/7' }))
    expect(await runLegacyMutation(opts)).toMatchObject({ status: 'unknown' })
    expect(fake.enqueue).not.toHaveBeenCalled()
    expect(opts.onError).toHaveBeenCalledOnce()
  })

  it('does not turn cancellation into an offline mutation', async () => {
    const opts = options()
    opts.call.mockRejectedValue(new axios.CanceledError('Cancelled'))
    expect(await runMutation(opts)).toBe(false)
    expect(fake.enqueue).not.toHaveBeenCalled()
  })
})
