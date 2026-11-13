import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TimelineCtx } from './timeline-context'
const fixture = vi.hoisted(() => ({ unmount: null as null | (() => void), handlers: null as null | { onMove: (event: PointerEvent) => void; onUp: () => void; onCancel: () => void } }))
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(), onBeforeUnmount: (fn: () => void) => { fixture.unmount = fn } }))
vi.mock('../utils', () => ({
  clamp: (value: number, min: number, max: number) => Math.max(min, Math.min(value, max)),
  useWindowPointerTrack: (handlers: NonNullable<typeof fixture.handlers>) => { fixture.handlers = handlers; return { start() {}, stop() {} } },
}))
import { beginMutation, hasActiveMutations, mayApplyRead, readStamp } from '@/offline/mutationGuard'
import { useBarDrag } from './useBarDrag'
const event = (clientX = 100) => ({ button: 0, clientX, preventDefault() {} }) as PointerEvent
function drag() {
  const commit = vi.fn()
  const timeline = { cellPx: 10, cellLeft: (cell: number) => cell * 10, cellCoordAtPointer: (x: number) => x / 10 } as unknown as TimelineCtx
  return { ...useBarDrag({ timeline: () => timeline, scrollEl: () => ({ getBoundingClientRect: () => ({ left: 0, right: 1000 }) }) as HTMLElement, sync() {}, getSpan: () => ({ startCell: 10, endCell: 12 }), onCommit: commit }), commit }
}
beforeEach(() => { fixture.unmount = null; fixture.handlers = null })
afterEach(() => { fixture.unmount?.() })
it.each(['move', 'resizeStart', 'resizeEnd'] as const)('protects %s preview from an older snapshot throughout the gesture', mode => {
  const before = readStamp(), bar = drag()
  bar.startDrag(event(), mode)
  expect(hasActiveMutations()).toBe(true); expect(mayApplyRead(before)).toBe(false)
  fixture.handlers!.onMove(event(120))
  expect(bar.isDragging.value).toBe(true); expect(bar.previewStyle.value).not.toBeNull()
  expect(bar.commit).not.toHaveBeenCalled()
  fixture.handlers!.onUp()
  expect(hasActiveMutations()).toBe(false); expect(bar.commit).toHaveBeenCalledOnce()
  expect(mayApplyRead(before)).toBe(false)
})
it.each(['cancel', 'unmount'])('releases preview protection on %s without submitting a mutation', reason => {
  const bar = drag(); bar.startDrag(event(), 'move'); fixture.handlers!.onMove(event(120))
  if (reason === 'cancel') fixture.handlers!.onCancel()
  else fixture.unmount!()
  expect(hasActiveMutations()).toBe(false); expect(bar.isDragging.value).toBe(false)
  expect(bar.commit).not.toHaveBeenCalled()
  fixture.unmount!(); expect(hasActiveMutations()).toBe(false)
})
it('ending a preview does not release another pending save', () => {
  const finishSave = beginMutation(), bar = drag()
  try {
    bar.startDrag(event(), 'move'); fixture.handlers!.onUp()
    expect(hasActiveMutations()).toBe(true)
  } finally { finishSave() }
  expect(hasActiveMutations()).toBe(false)
})
