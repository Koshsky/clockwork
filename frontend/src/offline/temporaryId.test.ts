import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTemporaryId } from './temporaryId'

afterEach(() => vi.restoreAllMocks())

describe('offline entity identity', () => {
  it.each([[0, 0], [0xffffffff, 0xffffffff], [1, 17], [0x80000000, 0x80000000]])(
    'remains a negative safe integer compatible with queued ID rewriting (%s, %s)', (high, low) => {
      vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
        ;(array as Uint32Array).set([high, low])
        return array
      })
      const id = createTemporaryId()
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeLessThanOrEqual(-1_000_000)
    },
  )

  it('does not alias records created while the wall clock is unchanged', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890000)
    let sequence = 0
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      ;(array as Uint32Array).set([0, ++sequence])
      return array
    })
    expect(createTemporaryId()).not.toBe(createTemporaryId())
  })
})
