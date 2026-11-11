/**
 * Unit tests for the per-user namespacing of the GET cache (cache.ts).
 * Pure helpers only — no IndexedDB/localStorage involved.
 */
import { describe, expect, it } from 'vitest'
import { keyMatchesUser, stripUserPrefix, userKeyOf } from './cache'

describe('userKeyOf', () => {
  it('prefixes the url with the user id', () => {
    expect(userKeyOf('/api/v1/user?limit=50&offset=0', 7)).toBe('u7:/api/v1/user?limit=50&offset=0')
    expect(userKeyOf('http://localhost:8080/api/v1/user', 6)).toBe('u6:http://localhost:8080/api/v1/user')
  })
})

describe('stripUserPrefix', () => {
  it('removes a user prefix so the url can be parsed again', () => {
    expect(stripUserPrefix('u7:/api/v1/user?limit=50')).toBe('/api/v1/user?limit=50')
    expect(stripUserPrefix('u9:http://localhost:8080/api/v1/user')).toBe(
      'http://localhost:8080/api/v1/user',
    )
  })

  it('leaves unprefixed keys untouched', () => {
    expect(stripUserPrefix('/api/v1/user?limit=50')).toBe('/api/v1/user?limit=50')
  })
})

describe('keyMatchesUser', () => {
  it('matches keys of the same user', () => {
    expect(keyMatchesUser('u7:/api/v1/user?limit=50', 7)).toBe(true)
    expect(keyMatchesUser('u7:http://x/api/v1/user', 7)).toBe(true)
  })

  it('rejects keys of other users', () => {
    expect(keyMatchesUser('u6:/api/v1/user?limit=50', 7)).toBe(false)
    expect(keyMatchesUser('u9:/api/v1/user', 7)).toBe(false)
  })

  it('rejects unprefixed keys when a user is known', () => {
    expect(keyMatchesUser('/api/v1/user?limit=50', 7)).toBe(false)
  })

  it('serves only unprefixed keys while the user is unknown (boot/logged out)', () => {
    expect(keyMatchesUser('/api/v1/user?limit=50', null)).toBe(true)
    expect(keyMatchesUser('u7:/api/v1/user?limit=50', null)).toBe(false)
    expect(keyMatchesUser('u6:/api/v1/user', null)).toBe(false)
  })

  it('handles negative/non-numeric prefixes defensively', () => {
    // Not produced by userKeyOf, but must not crash the scan.
    expect(keyMatchesUser('u7x:/api/v1/user', 7)).toBe(false)
    expect(stripUserPrefix('u7x:/api/v1/user')).toBe('u7x:/api/v1/user')
  })
})