// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref } from 'vue'
import ResourceHeader from './ResourceHeader.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'
import type { PlanningUnit } from '@/domain/calendar'

let unmount = () => {}
afterEach(() => { unmount(); document.body.replaceChildren(); vi.useRealTimers() })

it.each(['day', 'week'] as PlanningUnit[])('shares %s cell geometry across 60 resource rows and reactive usage updates', async (unit) => {
  const makeTimeline = (windowStart: number) => {
    const timeline = makeDemoTimeline('2020-12-28', unit, { viewportCells: 32, windowStart })
    return { ...timeline, cellStart: vi.fn(timeline.cellStart), cellEnd: vi.fn(timeline.cellEnd) }
  }
  const timeline = ref(makeTimeline(0))
  const demand = ref(1), available = ref<number | null>(2)
  const resources = reactive(Array.from({ length: 60 }, (_, id) => ({ id: id + 1, code: String(id + 1), title: '', employeesCount: 2 })))
  const app = createApp(() => h(ResourceHeader, { t: timeline.value, resources, usageFn: () => demand.value, availableFn: () => available.value }))
  const host = document.createElement('div'); document.body.append(host)
  app.mount(host); unmount = () => app.unmount()
  const geometry = timeline.value
  expect(geometry.cellStart).toHaveBeenCalledTimes(32)
  expect(geometry.cellEnd).toHaveBeenCalledTimes(32)
  expect(host.querySelectorAll('.rs-cell')).toHaveLength(1920)
  const firstCell = host.querySelector('.rs-cell')
  expect(host.querySelector('.rs-cell')?.getAttribute('data-date')).toBe('2020-12-28')
  expect(host.querySelector('.uc-inner')?.textContent).toBe('1/2')
  demand.value = 3; available.value = 0
  await nextTick()
  expect(host.querySelector('.uc-inner')?.textContent).toBe('3/0')
  available.value = null
  await nextTick()
  expect(host.querySelector('.uc-inner')?.textContent).toBe('3')
  expect(geometry.cellStart).toHaveBeenCalledTimes(32)
  expect(geometry.cellEnd).toHaveBeenCalledTimes(32)
  timeline.value = makeTimeline(32)
  await nextTick()
  expect(host.querySelector('.rs-cell')).toBe(firstCell)
  expect(timeline.value.cellStart).toHaveBeenCalledTimes(32)
  expect(timeline.value.cellEnd).toHaveBeenCalledTimes(32)
  expect(host.querySelector('.rs-cell')?.getAttribute('data-date')).toBe(unit === 'day' ? '2021-01-29' : '2021-08-09')
  resources.splice(0, 30)
  await nextTick()
  expect(host.querySelectorAll('.rs-row')).toHaveLength(30)
  expect(timeline.value.cellStart).toHaveBeenCalledTimes(32)
})

it('closes visible and pending tooltips when a reused slot changes its date or unit', async () => {
  vi.useFakeTimers()
  const timeline = ref(makeDemoTimeline('2026-11-09', 'day', { viewportCells: 2 }))
  const app = createApp(() => h(ResourceHeader, {
    t: timeline.value, resources: [{ id: 1, code: 'R', title: '', employeesCount: 1 }],
    usageFn: (_id: number, day: Date) => day.getDate(), availableFn: () => 1,
  }))
  const host = document.createElement('div'); document.body.append(host)
  app.mount(host); unmount = () => app.unmount()
  const cell = host.querySelector('.rs-cell')!
  const hover = () => cell.querySelector('.tt-trigger')!.dispatchEvent(new MouseEvent('mouseenter', { clientX: 200, clientY: 100 }))
  hover(); await vi.advanceTimersByTimeAsync(401)
  expect(document.querySelectorAll('.tt-popup')).toHaveLength(1)
  timeline.value = makeDemoTimeline('2026-11-09', 'day', { viewportCells: 2, windowStart: 1 })
  await nextTick()
  expect(host.querySelector('.rs-cell')).toBe(cell)
  expect(cell.getAttribute('data-date')).toBe('2026-11-10')
  expect(cell.querySelector('.uc-inner')?.textContent).toBe('10/1')
  expect(document.querySelectorAll('.tt-popup')).toHaveLength(0)
  hover(); await vi.advanceTimersByTimeAsync(200)
  timeline.value = makeDemoTimeline('2026-11-09', 'week', { viewportCells: 2, windowStart: 1 })
  await nextTick(); await vi.advanceTimersByTimeAsync(401)
  expect(document.querySelectorAll('.tt-popup')).toHaveLength(0)
  expect(cell.getAttribute('data-date')).toBe('2026-11-16')
  expect(cell.querySelector('.uc-inner')?.textContent).toBe('22/1')
  hover(); await vi.advanceTimersByTimeAsync(401)
  expect(document.querySelectorAll('.tt-popup')).toHaveLength(1)
})
