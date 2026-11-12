/**
 * Pure-logic unit tests for the outbox mutation queue (src/offline/outbox.ts).
 *
 * Runs in the vitest `unit` node project: all browser/IndexedDB dependencies
 * (db.ts, state.ts, cacheApply.ts, config.ts, token.ts, axios) are replaced
 * with in-memory fakes, so the queue semantics themselves are exercised
 * deterministically:
 *  - enqueue dedup (method+url+body equality);
 *  - temp-id → real-id mapping (idmap) applied to dependent queue entries;
 *  - idempotent drop of DELETE answered 404/410;
 *  - FIFO flush ordering by ts (entries are sorted, not send-in-map-order);
 *  - quarantine/backoff gate retries without deleting entries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** In-memory fake replacing the IndexedDB layer (offline/db.ts). */
const fake = vi.hoisted(() => {
  const stores: Record<string, Map<string, unknown>> = {
    outbox: new Map<string, unknown>(),
    idmap: new Map<string, unknown>(),
    cache: new Map<string, unknown>(),
  }
  const store = (name: string): Map<string, unknown> => {
    stores[name] ??= new Map<string, unknown>()
    return stores[name]
  }
  const reset = (): void => {
    for (const m of Object.values(stores)) m.clear()
  }
  return { store, reset }
})

/** Shared axios mock: the default axios export is a callable instance fn. */
const axiosCall = vi.hoisted(() => {
  const fn = vi.fn()
  return { fn }
})

vi.mock('./db', () => ({
  IDMAP_STORE_NAME: 'idmap',
  idbPut: vi.fn(async (s: string, k: string, v: unknown) => {
    fake.store(s).set(k, v)
  }),
  idbGet: vi.fn(async (s: string, k: string) => fake.store(s).get(k)),
  idbDel: vi.fn(async (s: string, k: string) => {
    fake.store(s).delete(k)
  }),
  idbAll: vi.fn(async (s: string) => [...fake.store(s).values()]),
  idbCount: vi.fn(async (s: string) => fake.store(s).size),
  idbKeys: vi.fn(async (s: string) => [...fake.store(s).keys()]),
}))

vi.mock('./state', () => ({
  probeBackend: vi.fn(async () => true),
}))
vi.mock('./cacheApply', () => ({
  applyToCache: vi.fn(async () => {
    /* no-op write-through overlay */
  }),
}))
vi.mock('@/config', () => ({
  getApiUrl: vi.fn(() => 'http://api.test/api/v1'),
}))
vi.mock('../token', () => ({
  getAccessToken: vi.fn(() => ''),
}))
vi.mock('axios', () => ({
  default: axiosCall.fn,
}))

import { enqueueMutation, flushOutbox, clearOutbox, createMutationKey, replayOutboxToCache, type OutboxEntry } from './outbox'
import { idbPut, idbDel, idbAll } from './db'

const okResponse = { data: { data: {} } }

function httpError(status: number, message?: string): { response: { status: number }; message: string } {
  return { response: { status }, message: message ?? `Request failed with status code ${status}` }
}

/** Seeds the outbox store directly with an entry (full control over ts). */
function seed(entry: Partial<OutboxEntry> & Pick<OutboxEntry, 'id' | 'ts' | 'method' | 'url' | 'entity'>): void {
  fake.store('outbox').set(entry.id, entry as OutboxEntry)
}

beforeEach(() => {
  fake.reset()
  vi.clearAllMocks()
  axiosCall.fn.mockResolvedValue(okResponse)
})

describe('enqueueMutation — dedup and persistence', () => {
  it('does not enqueue a duplicate (same method+url+body) twice', async () => {
    const entry = {
      entity: 'resource' as const,
      method: 'POST' as const,
      url: 'http://api.test/api/v1/resource',
      body: { title: 'Токарный станок', code: 'R-1' },
    }
    await enqueueMutation(entry)
    await enqueueMutation(entry)
    expect(fake.store('outbox').size).toBe(1)
    // The same object typed as a JSON string is normalized and also deduped.
    await enqueueMutation({
      ...entry,
      body: JSON.stringify({ title: 'Токарный станок', code: 'R-1' }),
    })
    expect(fake.store('outbox').size).toBe(1)
  })

  it('enqueues a sibling mutation when the body differs', async () => {
    await enqueueMutation({
      entity: 'resource' as const,
      method: 'POST' as const,
      url: 'http://api.test/api/v1/resource',
      body: { title: 'А' },
    })
    await enqueueMutation({
      entity: 'resource' as const,
      method: 'POST' as const,
      url: 'http://api.test/api/v1/resource',
      body: { title: 'Б' },
    })
    expect(fake.store('outbox').size).toBe(2)
  })

  it('enqueues separately when the method or url differs', async () => {
    await enqueueMutation({
      entity: 'resource' as const,
      method: 'PUT' as const,
      url: 'http://api.test/api/v1/resource/1',
      body: { title: 'X' },
    })
    await enqueueMutation({
      entity: 'resource' as const,
      method: 'PUT' as const,
      url: 'http://api.test/api/v1/resource/2',
      body: { title: 'X' },
    })
    expect(fake.store('outbox').size).toBe(2)
  })
})

describe('flushOutbox — temp-id → real-id mapping (idmap)', () => {
  it('rewrites dependent entry urls/bodies with the real id returned by the create', async () => {
    let call = 0
    axiosCall.fn.mockImplementation(async (_config: { url: string }) => {
      call++
      if (call === 1) {
        // The create answers with the real entity id.
        return { data: { data: { id: 42 } } }
      }
      return okResponse
    })

    seed({ id: 'create', ts: 100, method: 'POST', url: 'http://api.test/api/v1/user', body: { name: 'Новичок' }, entity: 'user', tempId: -1700000000000 })
    seed({
      id: 'dep',
      ts: 200,
      method: 'PUT',
      url: 'http://api.test/api/v1/user/-1700000000000/days',
      body: { user_id: -1700000000000 },
      entity: 'user',
    })

    const result = await flushOutbox()

    expect(result.ok).toBe(2)
    expect(result.failed).toBe(0)
    // The mapping was persisted to IndexedDB BEFORE the creator entry was deleted.
    expect(vi.mocked(idbPut).mock.calls.some(([store, key]) => store === 'idmap' && key === '-1700000000000')).toBe(true)
    // The dependent entry went out with the REAL id in both the url and the body.
    const depCall = axiosCall.fn.mock.calls[1][0] as { url?: string; data?: unknown }
    expect(depCall?.url).toContain('/api/v1/user/42/days')
    expect((depCall?.data as { user_id?: number })?.user_id).toBe(42)
    // Completed mappings remain available to later edits from sibling tabs.
    expect(fake.store('outbox').size).toBe(0)
    expect(fake.store('idmap').size).toBe(1)
  })

  it('reads the real id from the nested data.user shape of a user create', async () => {
    axiosCall.fn.mockResolvedValueOnce({ data: { data: { user: { id: 55 }, password: 'temp' } } })
    axiosCall.fn.mockResolvedValue(okResponse)

    seed({ id: 'c', ts: 100, method: 'POST', url: 'http://api.test/api/v1/user', body: { name: 'B' }, entity: 'user', tempId: -1800000000000 })
    seed({ id: 'd', ts: 200, method: 'PUT', url: 'http://api.test/api/v1/user/-1800000000000', body: { position: 'Инженер' }, entity: 'user' })

    const result = await flushOutbox()

    expect(result.ok).toBe(2)
    expect(axiosCall.fn.mock.calls[1][0]?.url).toContain('/api/v1/user/55')
  })

  it('sends an Idempotency-Key header on mutating methods (stable across retries)', async () => {
    seed({ id: 'upd', ts: 100, method: 'PUT', url: 'http://api.test/api/v1/resource/1', body: { title: 'X' }, entity: 'resource' })
    await flushOutbox()
    const config = axiosCall.fn.mock.calls[0][0] as { headers?: Record<string, string>; id?: string }
    expect(config?.headers?.['Idempotency-Key']).toBe('upd')
  })
})

describe('flushOutbox — idempotent drop of DELETE 404/410', () => {
  it.each([404, 410])('drops a DELETE answered %i and counts it as ok', async (status) => {
    axiosCall.fn.mockRejectedValueOnce(httpError(status))
    seed({ id: 'del', ts: 100, method: 'DELETE', url: 'http://api.test/api/v1/resource/99', entity: 'resource' })

    const result = await flushOutbox()

    expect(result.ok).toBe(1)
    expect(result.failed).toBe(0)
    expect(fake.store('outbox').size).toBe(0)
  })

  it('keeps a DELETE that the server rejected with a real error (500)', async () => {
    axiosCall.fn.mockRejectedValueOnce(httpError(500))
    seed({ id: 'del', ts: 100, method: 'DELETE', url: 'http://api.test/api/v1/resource/99', entity: 'resource' })

    const result = await flushOutbox()

    expect(result.ok).toBe(0)
    expect(result.failed).toBe(1)
    const kept = fake.store('outbox').get('del') as OutboxEntry
    expect(kept).toBeDefined()
    expect(kept.attempts).toBe(1)
    expect(kept.failed).toBeDefined()
  })
})

describe('flushOutbox — ordering and retry gates', () => {
  it('sends entries in ts (FIFO) order even when the store returns them unsorted', async () => {
    seed({ id: 'a', ts: 300, method: 'PUT', url: 'http://api.test/api/v1/resource/3', entity: 'resource' })
    seed({ id: 'b', ts: 100, method: 'PUT', url: 'http://api.test/api/v1/resource/1', entity: 'resource' })
    seed({ id: 'c', ts: 200, method: 'PUT', url: 'http://api.test/api/v1/resource/2', entity: 'resource' })

    const result = await flushOutbox()

    expect(result.ok).toBe(3)
    const urls = axiosCall.fn.mock.calls.map((c) => (c[0] as { url?: string })?.url)
    expect(urls).toEqual([
      'http://api.test/api/v1/resource/1',
      'http://api.test/api/v1/resource/2',
      'http://api.test/api/v1/resource/3',
    ])
  })

  it('skips quarantined entries and entries still in backoff without sending them', async () => {
    const axiosCalls = axiosCall.fn.mock.calls.length
    seed({ id: 'q', ts: 100, method: 'PUT', url: 'http://api.test/api/v1/resource/1', entity: 'resource', quarantined: true })
    seed({ id: 'bf', ts: 200, method: 'PUT', url: 'http://api.test/api/v1/resource/2', entity: 'resource', failed: { message: 'boom', at: Date.now() } })

    const result = await flushOutbox()

    expect(result.ok).toBe(0)
    expect(result.failed).toBe(0)
    expect(axiosCall.fn.mock.calls.length).toBe(axiosCalls)
    // Entries are preserved — retries are gated, the queue is never wiped.
    expect(fake.store('outbox').size).toBe(2)
  })
})

describe('clearOutbox', () => {
  it('removes every entry and the idmap rows', async () => {
    seed({ id: 'a', ts: 100, method: 'POST', url: 'http://api.test/api/v1/user', entity: 'user', tempId: -1700000000000 })
    await vi.mocked(idbPut)('idmap', '-1700000000000', { temp: -1700000000000, real: 42 })
    expect(await vi.mocked(idbAll)('outbox')).toHaveLength(1)

    await clearOutbox()

    expect(fake.store('outbox').size).toBe(0)
    expect(fake.store('idmap').size).toBe(0)
    void idbDel
  })
})
describe('P0 persistence and replay regressions', () => {
  it('generates keys on insecure origins without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {})
    try {
      const first = createMutationKey()
      const second = createMutationKey()
      expect(first).toMatch(/^m-/)
      expect(second).not.toBe(first)
    } finally { vi.unstubAllGlobals() }
  })

  it('retains the initial online request key across persistence and replay', async () => {
    await enqueueMutation({ entity: 'task', method: 'POST', url: 'http://api.test/api/v1/task', body: { title: 'Lost response' }, tempId: -1, idempotencyKey: 'initial-key' })
    axiosCall.fn.mockResolvedValueOnce({ data: { data: { id: 42 } } })
    await flushOutbox()
    expect(axiosCall.fn.mock.calls[0][0].headers['Idempotency-Key']).toBe('initial-key')
  })

  it('gives sequential enqueues a stable order even within the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      await enqueueMutation({ entity: 'task', method: 'POST', url: 'http://api.test/api/v1/task', body: { title: 'First' }, tempId: -1 })
      await enqueueMutation({ entity: 'task', method: 'PUT', url: 'http://api.test/api/v1/task/-1', body: { title: 'Second' } })
      const entries = [...fake.store('outbox').values()] as OutboxEntry[]
      expect(entries[0].ts).toBeLessThan(entries[1].ts)
    } finally { now.mockRestore() }
  })

  it('rewrites complete numeric ids without changing titles, dates or longer ids', async () => {
    seed({ id: 'create', ts: 1, entity: 'task', method: 'POST', url: 'http://api.test/api/v1/task', body: {}, tempId: -1 })
    seed({ id: 'update', ts: 2, entity: 'task', method: 'PUT', url: 'http://api.test/api/v1/task/-10', body: { task_id: -1, other_id: -10, title: 'Task -1', start_date: '2026-11-10' } })
    axiosCall.fn.mockResolvedValueOnce({ data: { data: { id: 42 } } }).mockResolvedValue(okResponse)
    await flushOutbox()
    const request = axiosCall.fn.mock.calls[1][0]
    expect(request.url).toContain('/task/-10')
    expect(request.data).toEqual({ task_id: 42, other_id: -10, title: 'Task -1', start_date: '2026-11-10' })
  })

  it('rewrites temporary ids in query parameters without changing date values', async () => {
    seed({ id: 'create', ts: 1, entity: 'state', method: 'POST', url: 'http://api.test/api/v1/timesheet/states', body: {}, tempId: -1 })
    seed({ id: 'clear', ts: 2, entity: 'period', method: 'DELETE', url: 'http://api.test/api/v1/user/5/days?state_id=-1&start_date=2026-11-10', body: {} })
    axiosCall.fn.mockResolvedValueOnce({ data: { data: { id: 42 } } }).mockResolvedValue(okResponse)
    await flushOutbox()
    const url = new URL(axiosCall.fn.mock.calls[1][0].url)
    expect(url.searchParams.get('state_id')).toBe('42')
    expect(url.searchParams.get('start_date')).toBe('2026-11-10')
  })

  it('retains an interrupted suffix and its id map for the next process', async () => {
    const { probeBackend } = await import('./state')
    vi.mocked(probeBackend).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    seed({ id: 'create', ts: 1, entity: 'task', method: 'POST', url: 'http://api.test/api/v1/task', body: {}, tempId: -1 })
    seed({ id: 'edit', ts: 2, entity: 'task', method: 'PUT', url: 'http://api.test/api/v1/task/-1', body: { title: 'Edited' } })
    seed({ id: 'assign', ts: 3, entity: 'assignment', method: 'POST', url: 'http://api.test/api/v1/assignment', body: { task_id: -1, resource_id: 3, quantity: 2 } })
    axiosCall.fn.mockResolvedValueOnce({ data: { data: { id: 42 } } }).mockRejectedValueOnce(new Error('offline'))
    const first = await flushOutbox()
    expect(first.ok).toBe(1)
    expect(first.interrupted).toBe(true)
    expect(fake.store('outbox').size).toBe(2)
    expect(fake.store('idmap').size).toBe(1)
    axiosCall.fn.mockResolvedValue(okResponse)
    const second = await flushOutbox()
    expect(second.ok).toBe(2)
    expect(axiosCall.fn.mock.calls[2][0].url).toContain('/task/42')
    expect(axiosCall.fn.mock.calls[3][0].data.task_id).toBe(42)
    expect(fake.store('outbox').size).toBe(0)
  })
})


it('replays the cached overlay in FIFO order rather than IndexedDB key order', async () => {
  const { applyToCache } = await import('./cacheApply')
  seed({ id: 'a', ts: 2, entity: 'task', method: 'PUT', url: 'http://api.test/api/v1/task/1', body: { title: 'Second' } })
  seed({ id: 'z', ts: 1, entity: 'task', method: 'PUT', url: 'http://api.test/api/v1/task/1', body: { title: 'First' } })
  await replayOutboxToCache()
  expect(vi.mocked(applyToCache).mock.calls.map(([item]) => item.id)).toEqual(['z', 'a'])
})

describe('flushOutbox — expired authorization', () => {
  it.each(['POST', 'PUT', 'DELETE'] as const)('pauses on %s 401 without damaging the queue', async (method) => {
    seed({ id: 'unauthorized', ts: 100, method, url: 'http://api.test/api/v1/task/1', entity: 'task', idempotencyKey: 'stable-key' })
    seed({ id: 'later', ts: 200, method: 'PUT', url: 'http://api.test/api/v1/task/2', entity: 'task' })
    const before = structuredClone([...fake.store('outbox').values()])
    axiosCall.fn.mockRejectedValueOnce(httpError(401))

    const result = await flushOutbox()

    expect(result.interrupted).toBe(true)
    expect(result.failed).toBe(0)
    expect(result.ok).toBe(0)
    expect(axiosCall.fn).toHaveBeenCalledTimes(1)
    expect([...fake.store('outbox').values()]).toEqual(before)
    expect(fake.store('idmap').size).toBe(0)

    axiosCall.fn.mockResolvedValue(okResponse)
    const resumed = await flushOutbox()
    expect(resumed.ok).toBe(2)
    expect(fake.store('outbox').size).toBe(0)
    expect(axiosCall.fn.mock.calls[1][0].headers['Idempotency-Key']).toBe('stable-key')
  })
})

it('does not let a second tab send a queue already being flushed', async () => {
  const held = new Set<string>()
  vi.stubGlobal('navigator', { locks: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null)
    held.add(name)
    try { return await run({}) } finally { held.delete(name) }
  } } })
  let reply!: (result: unknown) => void
  axiosCall.fn.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  seed({ id: 'shared', ts: 1, method: 'PUT', url: '/task/7', entity: 'task', body: { title: 'updated' } })
  const first = flushOutbox()
  await vi.waitFor(() => expect(axiosCall.fn).toHaveBeenCalledTimes(1))
  vi.resetModules()
  const sibling = await import('./outbox')
  const second = sibling.flushOutbox()
  await new Promise(resolve => setTimeout(resolve, 10))
  const calls = axiosCall.fn.mock.calls.length
  reply(okResponse)
  await Promise.all([first, second])
  vi.unstubAllGlobals()
  expect(calls).toBe(1)
  expect(fake.store('outbox').size).toBe(0)
})

it('keeps completed id mappings for dependent edits enqueued later by another tab', async () => {
  seed({ id: 'create', ts: 1, method: 'POST', url: '/task', entity: 'task', tempId: -20, body: { title: 'draft' } })
  axiosCall.fn.mockResolvedValueOnce({ data: { data: { id: 200 } } })
  await flushOutbox()
  seed({ id: 'late-edit', ts: 2, method: 'PUT', url: '/task/-20', entity: 'task', body: { title: 'edited' } })
  await flushOutbox()
  expect(axiosCall.fn.mock.calls[1][0].url).toContain('/task/200')
  expect(fake.store('outbox').size).toBe(0)
})


it('preserves visible pending work when a temporary storage error prevents reading the queue', async () => {
  const { pendingCount, pendingRefs, refreshPendingCount } = await import('./outbox')
  seed({ id: 'pending', ts: 1, method: 'PUT', url: '/task/7', entity: 'task' })
  await refreshPendingCount()
  expect(pendingCount.value).toBe(1)
  const before = pendingRefs.value
  vi.mocked(idbAll).mockRejectedValueOnce(new Error('temporarily blocked'))
  await refreshPendingCount()
  expect(pendingCount.value).toBe(1)
  expect(pendingRefs.value).toBe(before)
  expect(fake.store('outbox').size).toBe(1)
})


it('stops a sibling flush after shared logout without changing its queued work', async () => {
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'mvs_erp_logged_out' ? '1' : null })
  try {
    seed({ id: 'after-logout', ts: 1, method: 'PUT', url: '/task/7', entity: 'task' })
    expect((await flushOutbox()).interrupted).toBe(true)
    expect(axiosCall.fn).not.toHaveBeenCalled()
    expect(fake.store('outbox').size).toBe(1)
  } finally { vi.unstubAllGlobals() }
})

it("does not overlay another account's queued work onto current API data", async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ username: 'current' }) })
  try {
    const { applyToCache } = await import('./cacheApply')
    seed({ id: 'foreign', ts: 1, method: 'PUT', url: '/task/7', entity: 'task', creator: 'previous' })
    seed({ id: 'own', ts: 2, method: 'PUT', url: '/task/8', entity: 'task', creator: 'current' })
    await replayOutboxToCache()
    expect(vi.mocked(applyToCache).mock.calls.map(([entry]) => entry.id)).toEqual(['own'])
    expect(fake.store('outbox').size).toBe(2)
  } finally { vi.unstubAllGlobals() }
})
it('stops legacy replay between entries after an account switch without deleting commands', async () => {
  let account = 'current'
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ username: account }) })
  try {
    const { applyToCache } = await import('./cacheApply')
    vi.mocked(applyToCache).mockImplementationOnce(async () => { account = 'next' })
    seed({ id: 'first', ts: 1, method: 'PUT', url: '/task/7', entity: 'task', creator: 'current' })
    seed({ id: 'second', ts: 2, method: 'PUT', url: '/task/8', entity: 'task', creator: 'current' })
    await replayOutboxToCache()
    expect(vi.mocked(applyToCache).mock.calls.map(([entry]) => entry.id)).toEqual(['first'])
    expect(fake.store('outbox').size).toBe(2)
  } finally { vi.unstubAllGlobals() }
})

it('replays the new account after waiting for an old account overlay to finish', async () => {
  let account = 'first'
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ username: account }) })
  try {
    const { applyToCache } = await import('./cacheApply')
    let finish!: () => void
    vi.mocked(applyToCache).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    seed({ id: 'first', ts: 1, method: 'PUT', url: '/task/7', entity: 'task', creator: 'first' })
    seed({ id: 'next', ts: 2, method: 'PUT', url: '/task/8', entity: 'task', creator: 'next' })
    const old = replayOutboxToCache()
    await vi.waitFor(() => expect(applyToCache).toHaveBeenCalledOnce())
    account = 'next'
    const recent = replayOutboxToCache(); finish()
    await Promise.all([old, recent])
    expect(vi.mocked(applyToCache).mock.calls.map(([entry]) => entry.id)).toEqual(['first', 'next'])
    expect(fake.store('outbox').size).toBe(2)
  } finally { vi.unstubAllGlobals() }
})
