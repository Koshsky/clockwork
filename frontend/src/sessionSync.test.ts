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
