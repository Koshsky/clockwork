import type { Meta, StoryObj } from '@storybook/vue3-vite'
import TaskGantt from './TaskGantt.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'

const now = new Date()
const y = now.getFullYear()
const day = (m: number, d: number) => new Date(y, m - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const meta: Meta<typeof TaskGantt> = {
  title: 'Components/Planner/TaskGantt',
  component: TaskGantt,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

const tasks = [
  { id: 1, title: 'Осмотр объекта', start_date: iso(day(1, 2)), end_date: iso(day(1, 5)), resources: [{ resource_id: 1, assignment_id: 1, quantity: 2, code: 'И' }] },
  { id: 2, title: 'Разработка ППР', start_date: iso(day(1, 4)), end_date: iso(day(1, 14)), resources: [{ resource_id: 1, assignment_id: 2, quantity: 1, code: 'И' }] },
  { id: 3, title: 'Закуп материалов', start_date: iso(day(1, 6)), end_date: iso(day(1, 20)), resources: [{ resource_id: 5, assignment_id: 3, quantity: 1, code: 'СВ' }] },
  { id: 4, title: 'Монтаж конструкций', start_date: iso(day(1, 12)), end_date: iso(day(1, 28)), resources: [{ resource_id: 2, assignment_id: 4, quantity: 3, code: 'МК' }] },
]

const milestones = [
  { id: 11, title: 'Согласование сметы', content: 'Утверждение сметной документации заказчиком', date: iso(day(1, 5)) },
  { id: 12, title: 'Поставка материалов', content: 'Приёмка партии на склад', date: iso(day(1, 15)) },
  { id: 13, title: 'Окончание монтажа', content: 'Финал работ, подготовка к приёмке', date: iso(day(1, 26)) },
]

function base(): Story['render'] {
  return () => ({
    components: { TaskGantt },
    data: () => ({
      timeline: makeDemoTimeline(iso(day(1, 1)), 'day'),
      tasks,
      milestones,
      title: 'Инсталляция',
      projectCode: 'КО-1001',
    }),
    template: `
      <div style="width:3000px;background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 6px rgba(0,0,0,.08);">
        <TaskGantt :timeline="timeline" :title="title" :projectCode="projectCode" :tasks="tasks" :milestones="milestones" />
      </div>
    `,
  })
}

export const Default: Story = { render: base() }

/**
 * All four link types on the real component: every connector leaves the
 * predecessor's anchor edge, enters the successor's bound edge and stops there
 * with a tick (the anchors per type are defined in `planner/dependencyPaths.ts`).
 */
const dependencies = [
  { id: 1, task_id: 2, depends_on_task_id: 1, type: 'ss' as const },
  { id: 2, task_id: 3, depends_on_task_id: 1, type: 'fs' as const },
  { id: 3, task_id: 4, depends_on_task_id: 3, type: 'ff' as const },
  { id: 4, task_id: 4, depends_on_task_id: 2, type: 'sf' as const },
]

export const WithDependencies: Story = {
  render: () => ({
    components: { TaskGantt },
    data: () => ({
      timeline: makeDemoTimeline(iso(day(1, 1)), 'day'),
      tasks,
      milestones,
      dependencies,
      title: 'Инсталляция',
      projectCode: 'КО-1001',
    }),
    template: `
      <div style="width:3000px;background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 6px rgba(0,0,0,.08);">
        <TaskGantt
          :timeline="timeline"
          :title="title"
          :projectCode="projectCode"
          :tasks="tasks"
          :milestones="milestones"
          :dependencies="dependencies"
        />
      </div>
    `,
  }),
}
