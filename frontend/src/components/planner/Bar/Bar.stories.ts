import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import Bar from './Bar.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'

const DAY_MS = 1000 * 60 * 60 * 24

/** Day offset between two "YYYY-MM-DD" strings (positive = later) */
function dayDelta(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  return Math.round(
    (new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / DAY_MS,
  )
}

const meta: Meta<typeof Bar> = {
  title: 'Components/Planner/Bar',
  component: Bar,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

const base = {
  timeline: makeDemoTimeline('2026-08-01', 'day'),
  startDate: '2026-08-03',
  endDate: '2026-08-14',
}

export const Default: Story = {
  args: { ...base, title: 'Задача', projectCode: 'КО-01' },
}

export const Process: Story = {
  args: {
    ...base,
    title: 'Процесс',
    projectCode: 'КО-01',
    color: '#1a73e8',
    opacity: 0.85,
    minWidth: 40,
    padding: '0 10px',
    shadow: true,
  },
}

export const Project: Story = {
  args: {
    ...base,
    title: 'КО-01_РП1_ВП1',
    color: '#1a73e8',
    opacity: 0.85,
    height: 40,
    top: 6,
  },
}

export const Bare: Story = {
  args: { ...base, title: '' },
}

/**
 * Wrapper for the keyboard tests: renders the bar on a timeline and records the
 * latest `change` payload (start/end, "YYYY-MM-DD/YYYY-MM-DD") into the DOM.
 */
function renderKeyboardFixture(unit: 'day' | 'decade') {
  return () => ({
    components: { Bar },
    data: () => ({
      timeline: makeDemoTimeline('2026-08-01', unit),
      start: '2026-08-03',
      end: '2026-08-14',
      change: '',
    }),
    template: `
      <div style="position:relative;width:3000px;height:40px;background:#f0f0f0;">
        <Bar :timeline="timeline" :start-date="start" :end-date="end" title="Задача" @change="start = $event.start_date; end = $event.end_date; change = $event.start_date + '/' + $event.end_date" />
        <div data-testid="bar-change" style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;">{{ change }}</div>
      </div>
    `,
  })
}

/**
 * Test (regression for 9a82778): Alt+ArrowRight / Alt+ArrowLeft move the bar by
 * exactly ONE calendar day in `day` unit — the keyboard handler lives on the
 * bar itself, so the play focuses the rendered `.gantt-bar` and dispatches
 * keydown events, then asserts the emitted `change` payload dates.
 */
export const KeyboardAltDayStepDay: Story = {
  name: 'Test: Alt+Arrows step the bar by one day (day unit)',
  tags: ['vitest'],
  render: renderKeyboardFixture('day'),
  play: async ({ canvasElement, step }) => {
    await step('mount: a draggable focusable bar is rendered', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const bar = canvasElement.querySelector<HTMLElement>('.gantt-bar')
      expect(bar).toBeTruthy()
      expect(bar?.getAttribute('role')).toBe('slider')
    })

    const bar = canvasElement.querySelector<HTMLElement>('.gantt-bar') as HTMLElement
    bar.focus()
    const displayed = () =>
      canvasElement.querySelector('[data-testid="bar-change"]')?.textContent ?? ''
    const press = async (key: string, altKey: boolean) => {
      bar.dispatchEvent(new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 20))
    }

    await step('Alt+ArrowRight moves the span exactly one day later', async () => {
      await press('ArrowRight', true)
      const [s, e] = displayed().split('/')
      expect(s).toBe('2026-08-04')
      expect(e).toBe('2026-08-15')
      expect(dayDelta('2026-08-03', s)).toBe(1)
      expect(dayDelta('2026-08-14', e)).toBe(1)
    })

    await step('Alt+ArrowLeft moves the span exactly one day earlier', async () => {
      await press('ArrowLeft', true)
      const [s, e] = displayed().split('/')
      expect(s).toBe('2026-08-03')
      expect(e).toBe('2026-08-14')
    })
  },
}

/**
 * Test (regression for 9a82778): in `decade` unit a plain arrow steps by a
 * whole decade cell, but Alt+Arrows still step by exactly ONE day.
 */
export const KeyboardAltDayStepDecade: Story = {
  name: 'Test: Alt+Arrows step by one day in decade unit',
  tags: ['vitest'],
  render: renderKeyboardFixture('decade'),
  play: async ({ canvasElement, step }) => {
    await step('mount: the bar renders on a decade timeline', async () => {
      await new Promise((r) => setTimeout(r, 50))
      expect(canvasElement.querySelector('.gantt-bar')).toBeTruthy()
    })

    const bar = canvasElement.querySelector<HTMLElement>('.gantt-bar') as HTMLElement
    bar.focus()
    const displayed = () =>
      canvasElement.querySelector('[data-testid="bar-change"]')?.textContent ?? ''
    const press = async (key: string, altKey: boolean) => {
      bar.dispatchEvent(new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 20))
    }

    await step('Alt+ArrowRight: +1 day (not a decade cell)', async () => {
      await press('ArrowRight', true)
      const [s, e] = displayed().split('/')
      expect(dayDelta('2026-08-03', s)).toBe(1)
      expect(dayDelta('2026-08-14', e)).toBe(1)
    })

    await step('Alt+ArrowLeft: back to the original dates (−1 day)', async () => {
      await press('ArrowLeft', true)
      expect(displayed()).toBe('2026-08-03/2026-08-14')
    })

    await step('plain ArrowRight still steps by a decade cell (3 cells ≈ 29 days)', async () => {
      await press('ArrowRight', false)
      const [s] = displayed().split('/')
      expect(dayDelta('2026-08-03', s)).toBeGreaterThan(1)
    })

    await step('Alt+ArrowLeft after a cell step: exactly −1 day from the new position', async () => {
      const before = displayed()
      await press('ArrowLeft', true)
      const [s, e] = displayed().split('/')
      const [bs, be] = before.split('/')
      expect(dayDelta(bs, s)).toBe(-1)
      expect(dayDelta(be, e)).toBe(-1)
    })
  },
}
