import { describe, expect, it, vi } from 'vitest'
import { createWebDiagnosticHistory } from './history'

describe('bounded web diagnostic history', () => {
  const create = () => createWebDiagnosticHistory({ version: '2.2.0', context: () => 'session' })
  it('exports empty history and known versions without loading or transmitting anything', () => {
    const fetch = vi.fn(), storage = vi.fn()
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('localStorage', { setItem: storage })
    try {
      const history = create()
      history.rememberBackendVersion('v1.6.0')
      expect(JSON.parse(history.report())).toEqual({ schema: 1, platform: 'web', frontend_version: '2.2.0', backend_version: '1.6.0', records: [] })
      expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it.each([
    [{ code: 'ECONNABORTED' }, 'timeout'], [{ code: 'ETIMEDOUT' }, 'timeout'], [{ name: 'TimeoutError' }, 'timeout'],
    [{ code: 'ERR_NETWORK' }, 'network_or_cors'], [{ response: { status: 401 } }, 'unauthorized'],
    [{ response: { status: 403 } }, 'forbidden'], [{ response: { status: 409 } }, 'conflict'],
    [{ response: { status: 503 } }, 'server_error'], [{ response: { status: 422 } }, 'http_error'], [new Error('secret'), 'unexpected'],
  ])('classifies an API failure from reviewed codes/statuses: %j', (error, classification) => {
    const history = create(); history.capture('api', error)
    expect(history.records.value[0]?.failure).toBe(classification)
    expect(history.report()).not.toContain('secret')
  })
  it.each(['component', 'window', 'promise', 'chunk', 'navigation', 'pdf'] as const)('captures a %s failure without free-form error context', kind => {
    const history = create(); history.capture(kind, new Error('private project, token and stack'))
    expect(history.records.value[0]?.failure).toBe(kind)
    expect(history.report()).not.toContain('private')
  })
  it('deduplicates repeats, keeps latest correlation and moves the group to the front', () => {
    let time = 100
    const history = createWebDiagnosticHistory({ version: '2.2.0', context: () => null, now: () => time })
    history.capture('api', { response: { status: 503 } }, 'a'.repeat(32))
    history.capture('pdf')
    time = 200
    history.capture('api', { response: { status: 503 } }, 'b'.repeat(32))
    expect(history.records.value).toHaveLength(2)
    expect(history.records.value[0]).toMatchObject({ count: 2, first_seen: 100, last_seen: 200, diagnostic: { request_id: 'b'.repeat(32) } })
  })
  it('evicts old groups above 50 and keeps each record below 2 KiB even with huge inputs', () => {
    const history = create()
    for (let status = 500; status < 560; status++) history.capture('api', { message: 'secret'.repeat(100000), response: { status } })
    expect(history.records.value).toHaveLength(50)
    expect(history.records.value[49]?.diagnostic.status).toBe(510)
    for (const record of history.records.value) expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeLessThanOrEqual(2048)
    expect(history.report()).not.toContain('secret')
  })
  it('never includes request bodies, names, tokens, URLs, query, arbitrary correlation or stacks', () => {
    const history = create(), secret = 'canary-secret'
    const error = Object.assign(new Error(secret), { config: { url: `/task/42?name=${secret}`, data: { password: secret }, headers: { Authorization: secret } }, response: { status: 500, headers: { cookie: secret }, data: { error: { code: 'INTERNAL_ERROR', message: secret }, name: secret } } })
    history.capture('api', error, secret)
    const exported = history.report()
    expect(exported).not.toContain(secret); expect(exported).not.toContain('/task/42')
    expect(history.records.value[0]?.diagnostic.error_code).toBe('INTERNAL_ERROR')
    expect(history.records.value[0]?.diagnostic.request_id).toBeUndefined()
  })
  it('clears history/versions at the session boundary and ignores old in-flight events/metadata', () => {
    let context = 'first'
    const history = createWebDiagnosticHistory({ version: '2.2.0', context: () => context })
    const scope = history.contextToken()
    history.capture('pdf'); history.rememberBackendVersion('1.6.0')
    context = 'second'
    history.capture('api', { response: { status: 500 } }, 'a'.repeat(32), scope)
    history.rememberBackendVersion('1.5.0', scope)
    expect(history.snapshot()).toMatchObject({ records: [], backend_version: 'unknown' })
    history.capture('component')
    expect(history.records.value).toHaveLength(1)
  })
  it('reset invalidates pending work even if an account changes within the same epoch', () => {
    const history = create(), scope = history.contextToken()
    history.reset()
    history.capture('api', { response: { status: 500 } }, undefined, scope)
    history.rememberBackendVersion('1.6.0', scope)
    expect(history.snapshot()).toMatchObject({ records: [], backend_version: 'unknown' })
  })
  it('isolates tabs, returns detached exports and clears without resetting known versions', () => {
    const first = create(), second = create()
    first.capture('pdf'); first.rememberBackendVersion('1.6.0')
    const snapshot = first.snapshot(); snapshot.records[0]!.diagnostic.error_code = 'private'
    expect(first.report()).not.toContain('private'); expect(second.records.value).toHaveLength(0)
    first.clear()
    expect(first.snapshot()).toMatchObject({ records: [], backend_version: '1.6.0' })
  })
  it.each([{ code: 'ERR_CANCELED' }, { name: 'AbortError' }])('ignores intentional cancellation: %j', error => {
    const history = create(); history.capture('api', error)
    expect(history.records.value).toHaveLength(0)
  })
  it('does not throw or export attacker objects when diagnostic inputs or the scope fail', () => {
    const hostile = new Proxy({}, { get() { throw new Error('private') } })
    const history = create()
    expect(() => history.capture('api', hostile, hostile)).not.toThrow()
    expect(history.report()).not.toContain('private')
    const broken = createWebDiagnosticHistory({ version: 'private', context: () => { throw new Error('private') } })
    expect(() => broken.capture('pdf')).not.toThrow()
    expect(broken.report()).not.toContain('private')
  })
})
