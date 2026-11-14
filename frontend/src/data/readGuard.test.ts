import { describe, expect, it } from 'vitest'
import { createReadGuard } from './readGuard'

describe('read generations', () => {
  it('keeps only the latest request eligible to update state', () => {
    const guard = createReadGuard()
    const first = guard.begin()
    expect(first.isCurrent()).toBe(true)
    const second = guard.begin()
    expect(first.isCurrent()).toBe(false)
    expect(second.isCurrent()).toBe(true)
  })

  it('invalidates outstanding reads across a profile reset', () => {
    const guard = createReadGuard()
    const request = guard.begin()
    guard.invalidate()
    expect(request.isCurrent()).toBe(false)
    expect(guard.begin().isCurrent()).toBe(true)
  })

  it('does not interfere with reads belonging to another consumer', () => {
    const first = createReadGuard()
    const second = createReadGuard()
    const request = second.begin()
    first.begin()
    first.invalidate()
    expect(request.isCurrent()).toBe(true)
  })
})
