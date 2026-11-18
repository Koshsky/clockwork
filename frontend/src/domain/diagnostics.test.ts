import { describe, expect, it, vi } from 'vitest'
import { diagnosticEvent } from './diagnostics'

describe('diagnostic privacy boundary', () => {
  it('keeps only reviewed fields from an Axios error and support-report context', () => {
    const secret = 'canary-secret'
    const error = Object.assign(new Error(secret), {
      code: 'ERR_NETWORK', stack: secret,
      config: { url: `https://user:${secret}@server/task/42?password=${secret}`, data: { password: secret }, headers: { Authorization: secret } },
      response: { status: 503, data: { error: { message: secret }, data: { name: secret } } },
    })
    const metadata = { platform: 'desktop', version: '2.2.0', request_id: 'a'.repeat(32), duration_ms: 123, server: secret, accountId: 42, profile: secret, sqlite: secret, vault: secret, password: secret, fullName: secret }
    expect(diagnosticEvent('outbox-send', error, metadata)).toEqual({ event: 'outbox-send', error_code: 'ERR_NETWORK', platform: 'desktop', version: '2.2.0', request_id: 'a'.repeat(32), duration_ms: 123, status: 503 })
    expect(JSON.stringify(diagnosticEvent('outbox-send', error, metadata))).not.toContain(secret)
    expect(error.config.data.password).toBe(secret)
  })
  it.each(['FORBIDDEN', 'CONFLICT', 'VALIDATION_ERROR', 'INTERNAL_ERROR'])('retains the controlled API code %s without its message or body', code => {
    expect(diagnosticEvent('outbox-send', { response: { status: 409, data: { error: { code, message: 'private project' } } } })).toEqual({ event: 'outbox-send', error_code: code, status: 409 })
  })
  it.each([null, 'Bearer canary-secret', new Error('canary-secret'), { code: 'canary-secret', stack: 'canary-secret' }, { response: { status: 'canary-secret', data: { error: { code: 'canary-secret' } } } }])('does not serialize unknown errors: %j', input => {
    expect(diagnosticEvent('http-network', input)).toEqual({ event: 'http-network', error_code: 'UNEXPECTED' })
  })
  it('rejects control characters, arbitrary headers, paths and excessive metadata', () => {
    expect(diagnosticEvent('runtime-start', null, { request_id: 'auth\r\nsecret', platform: 'canary-secret', version: '2.2.0\nsecret', duration_ms: Infinity, name: 'canary-secret', data: 'x'.repeat(100000) })).toEqual({ event: 'runtime-start', error_code: 'UNEXPECTED' })
  })
  it('does not invoke error formatting, retain contexts or perform network reporting', () => {
    const stringify = vi.fn(() => { throw new Error('must not stringify') })
    const network = vi.fn(() => { throw new Error('must not upload') })
    vi.stubGlobal('fetch', network)
    try {
      const first = diagnosticEvent('runtime-cleanup', { toString: stringify, toJSON: stringify }, { accountId: 1 })
      const second = diagnosticEvent('runtime-cleanup', {}, { accountId: 2 })
      expect(first).toEqual(second)
      expect(stringify).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
  it('does not propagate malformed diagnostic input failures to the application', () => {
    const hostile = new Proxy({}, { get() { throw new Error('canary-secret') } })
    expect(diagnosticEvent('desktop-start', hostile, hostile)).toEqual({ event: 'desktop-start', error_code: 'UNEXPECTED' })
  })
  it('reads each untrusted value once so getters cannot replace a validated field', () => {
    const once = (first: unknown) => { let reads = 0; return () => ++reads === 1 ? first : 'canary-secret' }
    const error = { get code() { return code() }, response: { get status() { return status() } } }
    const code = once('ERR_NETWORK'), status = once(503), version = once('2.2.0'), requestId = once('a'.repeat(32))
    const event = diagnosticEvent('http-network', error, { get version() { return version() }, get request_id() { return requestId() } })
    expect(event).toEqual({ event: 'http-network', error_code: 'ERR_NETWORK', status: 503, version: '2.2.0', request_id: 'a'.repeat(32) })
    expect(JSON.stringify(event)).not.toContain('canary-secret')
  })

})
