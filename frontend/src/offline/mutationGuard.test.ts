import { describe, expect, it } from 'vitest'
import { beginMutation, hasActiveMutations, mayApplyRead, readStamp } from './mutationGuard'

describe('read protection around optimistic writes', () => {
  it('allows an unchanged server read', () => {
    expect(mayApplyRead(readStamp())).toBe(true)
  })
  it('rejects reads started before, during and across a completed write', () => {
    const before = readStamp()
    const finish = beginMutation()
    const during = readStamp()
    expect(hasActiveMutations()).toBe(true)
    expect(mayApplyRead(before)).toBe(false)
    expect(mayApplyRead(during)).toBe(false)
    finish()
    expect(mayApplyRead(before)).toBe(false)
    expect(mayApplyRead(during)).toBe(false)
    expect(mayApplyRead(readStamp())).toBe(true)
  })
  it('waits for every concurrent write and makes finish idempotent', () => {
    const first = beginMutation()
    const second = beginMutation()
    first()
    first()
    expect(hasActiveMutations()).toBe(true)
    expect(readStamp()).toBeNull()
    second()
    expect(hasActiveMutations()).toBe(false)
  })
})
