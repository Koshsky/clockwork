import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../i18n', () => ({ t: (key: string) => key }))

function database(stores = ['cache', 'outbox', 'idmap', 'session']) {
  const result = { result: undefined as unknown, error: null, onerror: null }
  const objectStore = { get: vi.fn(() => result), put: vi.fn(() => result) }
  const tx = {
    objectStore: vi.fn(() => objectStore), abort: vi.fn(), error: null,
    oncomplete: null as (() => void) | null, onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
  }
  return {
    version: 4, objectStoreNames: { contains: (name: string) => stores.includes(name) },
    createObjectStore: vi.fn(), close: vi.fn(), transaction: vi.fn(() => tx),
    onversionchange: null as (() => void) | null, onclose: null as (() => void) | null,
    tx, result, objectStore,
  }
}
function opening(db = database()) {
  return {
    result: db, error: null, transaction: { abort: vi.fn() },
    onsuccess: null as (() => void) | null, onerror: null as (() => void) | null,
    onblocked: null as (() => void) | null, onupgradeneeded: null as (() => void) | null,
  }
}
let requests: ReturnType<typeof opening>[]
let factory: { open: ReturnType<typeof vi.fn>; deleteDatabase: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  requests = []
  factory = { open: vi.fn(() => { const req = opening(); requests.push(req); return req }), deleteDatabase: vi.fn() }
  vi.stubGlobal('indexedDB', factory)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const tick = () => vi.advanceTimersByTimeAsync(0)

describe('IndexedDB progress and recovery', () => {
  it('rejects a stalled open and allows the next operation to reconnect', async () => {
    const { idbGet } = await import('./db')
    const first = idbGet('session', 'refresh').catch(error => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await Promise.race([first, Promise.resolve('still pending')])).toBeInstanceOf(Error)
    const second = idbGet('session', 'refresh')
    expect(factory.open).toHaveBeenCalledTimes(2)
    requests[1].onsuccess?.()
    await tick()
    requests[1].result.result.result = 'saved'
    requests[1].result.tx.oncomplete?.()
    expect(await second).toBe('saved')
    expect(factory.deleteDatabase).not.toHaveBeenCalled()
  })

  it('bounds an upgrade blocked by a legacy connection without deleting the database', async () => {
    const { idbGet } = await import('./db')
    const read = idbGet('session', 'refresh').catch(error => error)
    requests[0].result = database(['cache', 'outbox', 'idmap'])
    requests[0].onsuccess?.()
    expect(requests).toHaveLength(2)
    requests[1].onblocked?.()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await Promise.race([read, Promise.resolve('still pending')])).toBeInstanceOf(Error)
    expect(factory.deleteDatabase).not.toHaveBeenCalled()
  })

  it('aborts a stalled session write so a late token cannot overwrite a newer session', async () => {
    const { idbPut } = await import('./db')
    const write = idbPut('session', 'refresh', 'old').catch(error => error)
    requests[0].onsuccess?.()
    await tick()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await Promise.race([write, Promise.resolve('still pending')])).toBeInstanceOf(Error)
    expect(requests[0].result.tx.abort).toHaveBeenCalledTimes(1)
    expect(factory.deleteDatabase).not.toHaveBeenCalled()
  })

  it('closes a late successful open instead of retaining an abandoned connection', async () => {
    const { idbGet } = await import('./db')
    const read = idbGet('session', 'refresh').catch(error => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await read).toBeInstanceOf(Error)
    requests[0].onsuccess?.()
    expect(requests[0].result.close).toHaveBeenCalledTimes(1)
    expect(requests[0].result.transaction).not.toHaveBeenCalled()
  })

  it('aborts an upgrade that starts after its caller timed out', async () => {
    const { idbGet } = await import('./db')
    const read = idbGet('session', 'refresh').catch(error => error)
    await vi.advanceTimersByTimeAsync(5000)
    await read
    requests[0].onupgradeneeded?.()
    expect(requests[0].transaction.abort).toHaveBeenCalledTimes(1)
    expect(requests[0].result.createObjectStore).not.toHaveBeenCalled()
  })

  it('waits for commit before reporting a successful session write', async () => {
    const { idbPut } = await import('./db')
    let saved = false
    const write = idbPut('session', 'refresh', 'new').then(() => { saved = true })
    requests[0].onsuccess?.()
    await tick()
    expect(saved).toBe(false)
    requests[0].result.tx.oncomplete?.()
    await write
    expect(saved).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(requests[0].result.tx.abort).not.toHaveBeenCalled()
  })

  it('reopens after the browser unexpectedly closes the database', async () => {
    const { idbGet } = await import('./db')
    const read = idbGet('session', 'refresh').catch(error => error)
    requests[0].onsuccess?.()
    await tick()
    requests[0].result.onclose?.()
    requests[0].result.tx.onabort?.()
    expect(await read).toBeInstanceOf(Error)
    const next = idbGet('session', 'refresh')
    expect(requests).toHaveLength(2)
    requests[1].onsuccess?.()
    await tick()
    requests[1].result.tx.oncomplete?.()
    await next
  })

  it('keeps a replacement connection when an old handle reports closure', async () => {
    const { idbGet } = await import('./db')
    const first = idbGet('session', 'refresh').catch(error => error)
    requests[0].onsuccess?.()
    await tick()
    await vi.advanceTimersByTimeAsync(5000)
    await first
    const second = idbGet('session', 'refresh')
    requests[1].onsuccess?.()
    await tick()
    const completeSecond = requests[1].result.tx.oncomplete
    requests[0].result.onclose?.()
    const third = idbGet('cache', 'test')
    await tick()
    expect(requests).toHaveLength(2)
    requests[1].result.tx.oncomplete?.()
    await third
    completeSecond?.()
    await second
  })

  it('rejects an aborted transaction even when the browser supplies no error', async () => {
    const { idbPut } = await import('./db')
    const write = idbPut('session', 'refresh', 'new').catch(error => error)
    requests[0].onsuccess?.()
    await tick()
    requests[0].result.tx.onabort?.()
    expect(await write).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('repairs missing stores and closes on a subsequent schema upgrade', async () => {
    const { idbGet } = await import('./db')
    const read = idbGet('session', 'refresh')
    requests[0].result = database(['cache', 'outbox', 'idmap'])
    requests[0].onsuccess?.()
    expect(factory.open).toHaveBeenLastCalledWith('erp-offline', 5)
    requests[1].result = database(['cache', 'outbox', 'idmap'])
    requests[1].onupgradeneeded?.()
    expect(requests[1].result.createObjectStore).toHaveBeenCalledExactlyOnceWith('session')
    requests[1].result.objectStoreNames.contains = () => true
    requests[1].onsuccess?.()
    await tick()
    requests[1].result.tx.oncomplete?.()
    await read
    requests[1].result.onversionchange?.()
    expect(requests[1].result.close).toHaveBeenCalledTimes(2)
    expect(factory.deleteDatabase).not.toHaveBeenCalled()
  })


  it('closes idle connections without waiting for another tab to request an upgrade', async () => {
    const { idbGet } = await import('./db')
    const read = idbGet('cache', 'test')
    requests[0].onsuccess?.()
    await tick()
    expect(requests[0].result.close).not.toHaveBeenCalled()
    requests[0].result.tx.oncomplete?.()
    await read
    expect(requests[0].result.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the shared connection open until all current transactions complete', async () => {
    const { idbGet } = await import('./db')
    const first = idbGet('cache', 'first')
    requests[0].onsuccess?.()
    await tick()
    const completeFirst = requests[0].result.tx.oncomplete
    const second = idbGet('session', 'refresh')
    await tick()
    completeFirst?.()
    await first
    expect(requests[0].result.close).not.toHaveBeenCalled()
    requests[0].result.tx.oncomplete?.()
    await second
    expect(requests[0].result.close).toHaveBeenCalledTimes(1)
  })

})
