import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import MilestoneMarker from './MilestoneMarker.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'

const now = new Date()
const y = now.getFullYear()
const day = (m: number, d: number) => new Date(y, m - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const meta: Meta<typeof MilestoneMarker> = {
  title: 'Components/Planner/MilestoneMarker',
  component: MilestoneMarker,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => ({
    components: { MilestoneMarker },
    data: () => ({
      timeline: makeDemoTimeline(iso(day(1, 1)), 'day'),
      d1: iso(day(2, 12)),
      d2: iso(day(2, 20)),
      d3: iso(day(3, 18)),
    }),
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <div style="position:relative;width:3000px;height:36px;background:#f0f0f0;border-radius:6px;overflow:hidden;">
          <MilestoneMarker :timeline="timeline" :date="d1" title="Сдача ППР" content="Утверждение ППР заказчиком" />
          <MilestoneMarker :timeline="timeline" :date="d2" title="Начало монтажа" color="#1a73e8" />
          <MilestoneMarker :timeline="timeline" :date="d3" title="Окончание работ" content="Финал монтажа" color="#188038" />
        </div>
        <div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;margin-top:6px;">Флажки по центру своих ячеек (16 февраля, 20 февраля, 18 марта).</div>
      </div>
    `,
  }),
}

export const WithRay: Story = {
  render: () => ({
    components: { MilestoneMarker },
    data: () => ({
      timeline: makeDemoTimeline(iso(day(1, 1)), 'day'),
      milestones: [
        { date: iso(day(1, 15)), title: 'КП согласовано' },
        { date: iso(day(2, 8)), title: 'Старт монтажа', color: '#1a73e8' },
        { date: iso(day(3, 18)), title: 'Окончание работ', color: '#188038' },
      ],
    }),
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <div style="position:relative;width:3000px;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;">
          <div style="height:20px;background:#fff8e1;border-bottom:1px solid #f0e6c8;"></div>
          <div v-for="i in 3" :key="i" style="height:36px;border-bottom:1px solid #e8e8e8;background:#fff;"></div>
          <MilestoneMarker v-for="ms in milestones" :key="ms.date" :timeline="timeline" :date="ms.date" :title="ms.title" :color="ms.color" :stripHeight="20" :draggable="false" />
        </div>
      </div>
    `,
  }),
}

export const DecadeUnit: Story = {
  render: () => ({
    components: { MilestoneMarker },
    data: () => ({
      timeline: makeDemoTimeline(iso(day(1, 1)), 'decade'),
      md: iso(day(3, 20)),
    }),
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <div style="position:relative;width:3000px;height:36px;background:#f0f0f0;border-radius:6px;overflow:hidden;">
          <MilestoneMarker :timeline="timeline" :date="md" title="Завершение этапа" content="Окончание закупочной кампании" color="#1a73e8" :draggable="false" />
        </div>
        <div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;margin-top:6px;">Декада: маркер по центру ячейки-декады (март, 21–31).</div>
      </div>
    `,
  }),
}

/**
 * Test (regression for 9a82778): a milestone on a `decade` timeline snaps into
 * its containing cell, but the label/tooltip must show the STORED date — here
 * 15.01.2026 — not the cell start (11.01.2026). Asserts the ARIA label/value
 * text and the actually rendered tooltip popup (opened via hover).
 */
export const DecadeTooltipShowsStoredDate: Story = {
  name: 'Test: decade tooltip shows the stored date, not the cell start',
  tags: ['vitest'],
  render: () => ({
    components: { MilestoneMarker },
    data: () => ({
      timeline: makeDemoTimeline(iso(day(1, 1)), 'decade'),
      md: iso(day(1, 15)),
    }),
    template: `
      <div style="position:relative;width:3000px;height:36px;background:#f0f0f0;">
        <MilestoneMarker :timeline="timeline" :date="md" title="Завершение этапа" content="Окончание закупочной кампании" />
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    await step('mount: the marker is rendered in the decade timeline', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const marker = canvasElement.querySelector('.ms-marker')
      expect(marker).toBeTruthy()
      // Snapped to its decade cell, not to the stored day.
      expect(canvasElement.querySelector('.ms')).toBeTruthy()
    })

    const marker = canvasElement.querySelector<HTMLElement>('.ms-marker') as HTMLElement

    await step('ARIA shows the stored date (15.01.2026), not the cell start (11.01.2026)', () => {
      const valueText = marker.getAttribute('aria-valuetext')
      const label = marker.getAttribute('aria-label') ?? ''
      expect(valueText).toBe('15.01.2026')
      expect(label).toContain('15.01.2026')
      expect(label).not.toContain('11.01.2026')
    })

    await step('hover opens the tooltip with the stored date', async () => {
      const trigger = canvasElement.querySelector<HTMLElement>('.tt-trigger')
      expect(trigger).toBeTruthy()
      trigger?.dispatchEvent(new MouseEvent('mouseenter', { clientX: 120, clientY: 80 }))
      // TooltipCell opens after its 400ms hover delay.
      await new Promise((r) => setTimeout(r, 500))
      const popup = document.body.querySelector<HTMLElement>('.tt-popup')
      expect(popup).toBeTruthy()
      const text = popup?.textContent ?? ''
      expect(text).toContain('Завершение этапа')
      expect(text).toContain('15.01.2026')
      expect(text).not.toContain('11.01.2026')
    })
  },
}
