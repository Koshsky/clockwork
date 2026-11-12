import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerActiveRead, refreshActiveReads, resumeActiveReads, stopActiveReads } from './activeReads'
const cleanups: Array<() => void> = []
const register = (read: () => Promise<unknown>) => { const stop = registerActiveRead(read); cleanups.push(stop); return stop }
beforeEach(resumeActiveReads)
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); stopActiveReads() })
it('refreshes mounted read models without stopping after an individual API failure', async () => {
  const first = vi.fn(async () => { throw new Error('network') }), second = vi.fn(async () => {})
  register(first); register(second)
  expect(await refreshActiveReads()).toBe(1)
  expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce()
})
it('does not overlap minute cycles', async () => {
  let finish!: () => void
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  register(send)
  const first = refreshActiveReads(), second = refreshActiveReads()
  expect(first).toBe(second); expect(send).toHaveBeenCalledOnce()
  finish(); await first
})
it('skips unmounted pages and unsaved editors', async () => {
  const read = vi.fn(async () => {}), stop = register(read)
  stop(); register(async () => false)
  expect(await refreshActiveReads()).toBe(0)
  expect(read).not.toHaveBeenCalled()
})
it('stops scheduling subsequent models after runtime teardown', async () => {
  let finish!: () => void
  register(() => new Promise<void>(resolve => { finish = resolve }))
  const later = vi.fn(async () => {}); register(later)
  const pending = refreshActiveReads(); stopActiveReads(); finish(); await pending
  expect(later).not.toHaveBeenCalled()
  expect(await refreshActiveReads()).toBe(0)
})

it('does not continue an old page-refresh generation after stop and resume', async () => {
  let finish!: () => void
  register(() => new Promise<void>(resolve => { finish = resolve }))
  const later = vi.fn(async () => {}); register(later)
  const pending = refreshActiveReads(); stopActiveReads(); resumeActiveReads(); finish(); await pending
  expect(later).not.toHaveBeenCalled()
})
