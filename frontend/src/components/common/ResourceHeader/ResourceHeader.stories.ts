import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ResourceHeader from './ResourceHeader.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'

const now = new Date()
const y = now.getFullYear()
const iso = `${y}-01-01`

const resources = [
  { id: 1, code: 'ПТО', title: 'Инженер ПТО', employeesCount: 4 },
  { id: 2, code: 'МК', title: 'Монтажник', employeesCount: 4 },
  { id: 3, code: 'РП', title: 'Руководитель проекта', employeesCount: 1 },
  { id: 4, code: 'СВ', title: 'Сварщик', employeesCount: 2 },
]

const meta: Meta<typeof ResourceHeader> = {
  title: 'Components/Planner/ResourceHeader',
  component: ResourceHeader,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

const demoAvailableFn = (rid: number, d: Date) => {
  if (d.getDate() % 7 === 0) return null
  return Math.max(1, 5 - (d.getDate() % 5) - rid)
}

export const Default: Story = {
  render: () => ({
    components: { ResourceHeader },
    data: () => ({
      t: makeDemoTimeline(iso, 'day', { viewportCells: 60 }),
      resources,
      usageFn: () => 0,
      availableFn: () => 4,
    }),
    template: `
      <div style="width:3000px;">
        <ResourceHeader :t="t" :resources="resources" :usageFn="usageFn" :availableFn="availableFn" />
      </div>
    `,
  }),
}

export const WithUsage: Story = {
  render: () => ({
    components: { ResourceHeader },
    data: () => ({
      t: makeDemoTimeline(iso, 'day', { viewportCells: 60 }),
      resources,
      usageFn: (rid: number, d: Date) => (d.getDate() % 3 === 0 ? rid + 1 : 0),
      availableFn: demoAvailableFn,
    }),
    template: `
      <div style="width:3000px;">
        <ResourceHeader :t="t" :resources="resources" :usageFn="usageFn" :availableFn="availableFn" />
      </div>
    `,
  }),
}
