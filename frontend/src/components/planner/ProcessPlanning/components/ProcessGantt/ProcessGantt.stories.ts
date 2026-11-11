import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ProcessGantt from './ProcessGantt.vue'
import type { ProcessItem } from './types'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'

const now = new Date()
const y = now.getFullYear()
const day = (m: number, d: number) => new Date(y, m - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const meta: Meta<typeof ProcessGantt> = {
  title: 'Components/Planner/ProcessGantt',
  component: ProcessGantt,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

function withProcesses(processes: ProcessItem[]): Story['render'] {
  return () => ({
    components: { ProcessGantt },
    data: () => ({ timeline: makeDemoTimeline(iso(day(1, 1)), 'day'), projectCode: 'КО-1234', processes }),
    template: `
      <div style="width:3000px;background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 6px rgba(0,0,0,.08);">
        <ProcessGantt :timeline="timeline" :projectCode="projectCode" :processes="processes" />
      </div>
    `,
  })
}

export const TwoProcesses: Story = {
  render: withProcesses([
    { id: 1, title: 'Производство', start_date: iso(day(1, 3)), end_date: iso(day(2, 5)) },
    { id: 2, title: 'Инсталляция', start_date: iso(day(1, 20)), end_date: iso(day(2, 25)) },
  ]),
}

export const Overlapping: Story = {
  render: withProcesses([
    { id: 1, title: 'Производство', start_date: iso(day(1, 1)), end_date: iso(day(2, 9)) },
    { id: 2, title: 'Инсталляция', start_date: iso(day(1, 30)), end_date: iso(day(2, 28)) },
    { id: 3, title: 'Пусконаладка', start_date: iso(day(2, 19)), end_date: iso(day(3, 1)) },
  ]),
}
