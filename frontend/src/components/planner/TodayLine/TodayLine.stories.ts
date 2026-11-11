import type { Meta, StoryObj } from '@storybook/vue3-vite'
import TodayLine from './TodayLine.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'
import { cellIndexForDate } from '../calendar'

const now = new Date()
const y = now.getFullYear()
const day = (m: number, d: number) => new Date(y, m - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const meta: Meta<typeof TodayLine> = {
  title: 'Components/Planner/TodayLine',
  component: TodayLine,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

export const DayUnit: Story = {
  render: () => ({
    components: { TodayLine },
    data: () => {
      const origin = iso(day(1, 1))
      const todayIdx = cellIndexForDate(origin, 'day', now)
      return {
        timeline: makeDemoTimeline(origin, 'day', { windowStart: todayIdx - 5, viewportCells: 40 }),
      }
    },
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <div style="position:relative;height:220px;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;background:#fff;">
          <div v-for="i in 4" :key="i" style="height:48px;border-bottom:1px solid #e8e8e8;"></div>
          <TodayLine :timeline="timeline" />
        </div>
        <div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;margin-top:6px;">Красный луч стоит на границе между «вчера» и «сегодня» — левый край ячейки текущего дня.</div>
      </div>
    `,
  }),
}

export const DecadeUnit: Story = {
  render: () => ({
    components: { TodayLine },
    data: () => {
      const origin = iso(day(1, 1))
      const todayIdx = cellIndexForDate(origin, 'decade', now)
      return {
        timeline: makeDemoTimeline(origin, 'decade', { windowStart: todayIdx - 3, viewportCells: 12 }),
      }
    },
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <div style="position:relative;height:220px;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;background:#fff;">
          <div v-for="i in 4" :key="i" style="height:48px;border-bottom:1px solid #e8e8e8;"></div>
          <TodayLine :timeline="timeline" />
        </div>
        <div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;margin-top:6px;">Декада: луч на дробной позиции текущего дня внутри ячейки-декады.</div>
      </div>
    `,
  }),
}

export const HiddenOutsideWindow: Story = {
  render: () => ({
    components: { TodayLine },
    data: () => {
      const origin = iso(day(1, 1))
      return {
        timeline: makeDemoTimeline(origin, 'day', { windowStart: 0, viewportCells: 40 }),
      }
    },
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <div style="position:relative;height:96px;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;background:#fff;">
          <TodayLine :timeline="timeline" />
        </div>
        <div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;margin-top:6px;">Окно далеко от сегодняшней даты — луч скрыт (виртуализация).</div>
      </div>
    `,
  }),
}
