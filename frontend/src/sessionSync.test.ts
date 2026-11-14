import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let occupied: boolean
let storage: Map<string, string>
let session: typeof import('./sessionSync')

beforeEach(async () => {
  vi.resetModules()
  occupied = false
  storage = new Map()
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (occupied) return run(null)
    occupied = true
    try { return await run({}) } finally { occupied = false }
  } } })
  session = await import('./sessionSync')
})

afterEach(() => vi.unstubAllGlobals())

describe('cross-tab refresh ownership', () => {
  it('holds the atomic lock through the complete refresh and admits the next owner afterwards', async () => {
    let finish!: (result: boolean) => void
    const first = session.withRefreshLock(() => new Promise(resolve => { finish = resolve }))
    const competing = vi.fn(async () => true)
    expect(await session.withRefreshLock(competing)).toBeNull()
    expect(competing).not.toHaveBeenCalled()
    finish(true)
    expect(await first).toBe(true)
    expect(storage.size).toBe(0)
    expect(await session.withRefreshLock(competing)).toBe(true)
    expect(competing).toHaveBeenCalledTimes(1)
  })

  it('releases the atomic lock when refresh throws', async () => {
    await expect(session.withRefreshLock(async () => { throw new Error('unreachable') })).rejects.toThrow('unreachable')
    expect(storage.size).toBe(0)
    expect(await session.withRefreshLock(async () => false)).toBe(false)
  })

  it('respects the legacy lock when Web Locks is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    storage.set('mvs_erp_refresh_lock', JSON.stringify({ owner: 'other-tab', ts: Date.now() }))
    const refresh = vi.fn(async () => true)
    expect(await session.withRefreshLock(refresh)).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('recovers an abandoned legacy lock after its lease expires', async () => {
    vi.stubGlobal('navigator', {})
    storage.set('mvs_erp_refresh_lock', JSON.stringify({ owner: 'closed-tab', ts: Date.now() - 15_001 }))
    expect(await session.withRefreshLock(async () => true)).toBe(true)
    expect(storage.size).toBe(0)
  })

  it.each([
    JSON.stringify({ owner: 'other', ts: Date.now() + 60_000 }),
    JSON.stringify({ owner: 'other', ts: 'not-a-timestamp' }),
    JSON.stringify({ ts: Date.now() }),
    '{broken',
  ])('recovers invalid or future-dated legacy lock metadata: %s', async value => {
    vi.stubGlobal('navigator', {})
    storage.set('mvs_erp_refresh_lock', value)
    expect(await session.withRefreshLock(async () => true)).toBe(true)
    expect(storage.size).toBe(0)
  })

  it('does not let a closed document storage lease block a free Web Lock', async () => {
    storage.set('mvs_erp_refresh_lock', JSON.stringify({ owner: 'closed-document', ts: Date.now() }))
    const refresh = vi.fn(async () => true)
    expect(await session.withRefreshLock(refresh)).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

})

describe('web credential separation', () => {
  it('never persists access or refresh credentials in a fallback storage event', () => {
    session.publishSession({ access: 'private-access', user: { id: 7, username: 'verified' } })
    expect([...storage.values()].join('')).not.toContain('private-access')
    expect(storage.has('mvs_erp_session_state')).toBe(false)
    expect(storage.has('mvs_erp_session_token')).toBe(false)
  })

  it('keeps logout generations and uncertain rotation metadata credential-free', () => {
    const previous = session.sessionEpoch()
    expect(session.advanceSessionEpoch()).not.toBe(previous)
    session.markSessionUncertain(true)
    expect(session.sessionUncertain()).toBe(true)
    session.markSessionUncertain(false)
    expect(session.sessionUncertain()).toBe(false)
  })

  it('fails closed when neither atomic locks nor a storage lease is available', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('blocked') } })
    const run = vi.fn(async () => true)
    expect(await session.withRefreshLock(run)).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('rechecks a competing storage claim before sending refresh', async () => {
    vi.stubGlobal('navigator', {})
    const run = vi.fn(async () => true)
    const pending = session.withRefreshLock(run)
    storage.set('mvs_erp_refresh_lock', JSON.stringify({ owner: 'winner', ts: Date.now() }))
    expect(await pending).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(JSON.parse(storage.get('mvs_erp_refresh_lock')!).owner).toBe('winner')
  })
})
it('does not send a cookie refresh if its replay fence cannot be persisted', () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('storage blocked') } })
  expect(session.markSessionUncertain(true)).toBe(false)
})
