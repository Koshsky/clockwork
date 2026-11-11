/**
 * Pure-logic unit tests for the in-memory access token (src/token.ts).
 *
 * Real contract of the module (AD-05): the access token lives ONLY in process
 * memory — never in localStorage — and the module exposes a trivial get/set
 * store. The proactive-refresh margin math (REFRESH_MARGIN_MS /
 * accessTokenExpiring) and the exp payload decoding live in store/index.ts
 * and are exercised there as the auth store's accessExpired check
 * (see src/store/index.test.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getAccessToken, setAccessToken } from './token'

describe('token.ts — in-memory access token', () => {
  beforeEach(() => setAccessToken(null))

  it('starts empty (no token in memory after a reload)', () => {
    expect(getAccessToken()).toBe('')
  })

  it('round-trips a token', () => {
    setAccessToken('eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE4MDAwMDAwMDB9.sig')
    expect(getAccessToken()).toBe('eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE4MDAwMDAwMDB9.sig')
  })

  it('setting null / empty string clears the token', () => {
    setAccessToken('abc')
    setAccessToken(null)
    expect(getAccessToken()).toBe('')
    setAccessToken('abc')
    setAccessToken('')
    expect(getAccessToken()).toBe('')
  })

  it('replaces the previous token on a new set', () => {
    setAccessToken('first')
    setAccessToken('second')
    expect(getAccessToken()).toBe('second')
  })
})