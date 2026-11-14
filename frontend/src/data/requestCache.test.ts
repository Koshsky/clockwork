import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequestCache, ReadCancelled, type RequestContext } from './requestCache'
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let scope: string, revision: number | null, time: number
let cache: ReturnType<typeof createRequestCache>
beforeEach(() => {
  scope = 'server-a:user-1'; revision = 0; time = 0
  cache = createRequestCache(() => ({ scope, revision }), (own: RequestContext) => own.scope === scope && own.revision != null && own.revision === revision, () => time)
})
describe('API read coordination', () => {
  it('deduplicates the same query without sharing a different consumer channel', async () => {
    const gate = deferred<number>(), send = vi.fn(() => gate.promise)
    const first = cache.read('resources', { offset: 0, owner: 1 }, send)
    const second = cache.read('resources', { owner: 1, offset: 0 }, send)
    const other = cache.read('header', { offset: 0, owner: 1 }, send)
    expect(send).toHaveBeenCalledTimes(2)
    gate.resolve(8)
    expect(await Promise.all([first, second, other])).toEqual([8, 8, 8])
  })
  it.each(['offset', 'owner', 'search', 'from', 'to'])('cancels an obsolete %s query and rejects its late answer', async field => {
    const gate = deferred<string>(); let signal!: AbortSignal
    const old = cache.read('query', { [field]: 1 }, request => { signal = request; return gate.promise })
    const rejected = expect(old).rejects.toBeInstanceOf(ReadCancelled)
    expect(await cache.read('query', { [field]: 2 }, async () => 'new')).toBe('new')
    expect(signal.aborted).toBe(true)
    gate.resolve('old'); await rejected
    expect(await cache.read('query', { [field]: 2 }, async () => 'wrong', { preferCache: true })).toBe('new')
  })
  it.each(['account', 'server', 'permissions', 'locale'])('rejects a response after the %s scope changes', async reason => {
    const gate = deferred<number>()
    const pending = cache.read('rows', undefined, () => gate.promise)
    scope += ':' + reason
    gate.resolve(1)
    await expect(pending).rejects.toBeInstanceOf(ReadCancelled)
  })
  it.each(['during', 'after'])('rejects snapshots taken %s a mutation', async mode => {
    const gate = deferred<number>()
    if (mode === 'during') revision = null
    const pending = cache.read('rows', undefined, () => gate.promise)
    revision = 2; gate.resolve(1)
    await expect(pending).rejects.toBeInstanceOf(ReadCancelled)
  })
  it('does not retain a cache hit after a later mutation', async () => {
    await cache.read('rows', 1, async () => 'old')
    revision = 2
    expect(await cache.read('rows', 1, async () => 'new', { preferCache: true })).toBe('new')
  })
  it('distinguishes a successfully loaded empty list from an unfetched list', async () => {
    const send = vi.fn(async () => [])
    expect(await cache.read('rows', 1, send)).toEqual([])
    expect(await cache.read('rows', 1, send, { preferCache: true })).toEqual([])
    expect(send).toHaveBeenCalledOnce()
  })
  it('reuses a fresh snapshot until the minute boundary and allows forced refresh', async () => {
    const send = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3)
    expect(await cache.read('rows', 1, send)).toBe(1)
    time = 59999
    expect(await cache.read('rows', 1, send, { preferCache: true })).toBe(1)
    time = 60000
    expect(await cache.read('rows', 1, send, { preferCache: true })).toBe(2)
    expect(await cache.read('rows', 1, send)).toBe(3)
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('does not cache errors or reuse a successful snapshot after access refusal', async () => {
    await cache.read('rows', 1, async () => [1])
    await expect(cache.read('rows', 1, async () => { throw new Error('forbidden') })).rejects.toThrow('forbidden')
    expect(await cache.read('rows', 1, async () => [], { preferCache: true })).toEqual([])
  })
  it('clears cached data and cancels all flights on account reset', async () => {
    await cache.read('saved', 1, async () => 'old')
    const gate = deferred<number>()
    const pending = cache.read('active', 1, () => gate.promise)
    const rejected = expect(pending).rejects.toBeInstanceOf(ReadCancelled)
    cache.invalidate(); gate.resolve(1); await rejected
    expect(cache.pending('active')).toBe(false)
    expect(await cache.read('saved', 1, async () => 'new', { preferCache: true })).toBe('new')
  })
  it('cancels flights on page pause while keeping the disposable cache', async () => {
    const send = vi.fn(async () => 'saved')
    await cache.read('saved', 1, send)
    const gate = deferred<number>()
    const pending = cache.read('active', 1, () => gate.promise)
    const rejected = expect(pending).rejects.toBeInstanceOf(ReadCancelled)
    cache.cancel(); gate.resolve(1); await rejected
    expect(await cache.read('saved', 1, send, { preferCache: true })).toBe('saved')
    expect(send).toHaveBeenCalledOnce()
  })
  it('does not send requests for an already-aborted view', async () => {
    const abort = new AbortController(); abort.abort(); const send = vi.fn()
    await expect(cache.read('rows', 1, send, { signal: abort.signal })).rejects.toBeInstanceOf(ReadCancelled)
    expect(send).not.toHaveBeenCalled()
  })
  it('cancels the network when the final subscriber leaves', async () => {
    const abort = new AbortController(), gate = deferred<number>(); let network!: AbortSignal
    const pending = cache.read('rows', 1, signal => { network = signal; return gate.promise }, { signal: abort.signal })
    const rejected = expect(pending).rejects.toBeInstanceOf(ReadCancelled)
    abort.abort(); await rejected
    expect(network.aborted).toBe(true)
    expect(cache.pending('rows')).toBe(false)
    gate.resolve(1)
  })
  it('does not cancel a shared network request while another view still needs it', async () => {
    const abort = new AbortController(), gate = deferred<number>(); let network!: AbortSignal
    const send = vi.fn((signal: AbortSignal) => { network = signal; return gate.promise })
    const leaving = cache.read('rows', 1, send, { signal: abort.signal })
    const remaining = cache.read('rows', 1, send)
    const rejected = expect(leaving).rejects.toBeInstanceOf(ReadCancelled)
    abort.abort(); await rejected
    expect(network.aborted).toBe(false)
    gate.resolve(7)
    expect(await remaining).toBe(7)
    expect(send).toHaveBeenCalledOnce()
  })
  it('bounds the in-memory query cache without touching durable data', async () => {
    const send = vi.fn(async () => 0)
    for (let n = 0; n < 257; n++) await cache.read('rows', n, send)
    expect(await cache.read('rows', 0, async () => 1, { preferCache: true })).toBe(1)
  })
})

it('preserves synchronous and falsy rejections instead of treating them as successful empty reads', async () => {
  await expect(cache.read('rows', 1, () => { throw new Error('sync failure') })).rejects.toThrow('sync failure')
  await expect(cache.read('rows', 1, () => Promise.reject(null))).rejects.toBeNull()
  expect(cache.pending('rows')).toBe(false)
})

it('cancels an obsolete network query even when the latest query is already cached', async () => {
  await cache.read('rows', 'cached', async () => 'cached result')
  const pending = cache.read('rows', 'obsolete', () => new Promise(() => {}))
  const rejected = expect(pending).rejects.toBeInstanceOf(ReadCancelled)
  expect(await cache.read('rows', 'cached', async () => 'wrong', { preferCache: true })).toBe('cached result')
  await rejected
  expect(cache.pending('rows')).toBe(false)
})
