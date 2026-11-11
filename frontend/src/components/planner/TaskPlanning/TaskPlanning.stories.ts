import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import TaskPlanning from './TaskPlanning.vue'
import { LABEL_WIDTH } from '../layout'
import type { DtoDetailedProcess, DtoResource } from '@/api'

const now = new Date()
const y = now.getFullYear()
const day = (month: number, d: number) => new Date(y, month - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const resources: DtoResource[] = [
  { id: 1, code: 'И', title: 'Инженер', quantity: 7 },
  { id: 2, code: 'М', title: 'Монтажник', quantity: 4 },
  { id: 3, code: 'ПР', title: 'Производитель работ', quantity: 2 },
  { id: 4, code: 'РГ', title: 'Руководитель группы', quantity: 4 },
  { id: 5, code: 'РСИ', title: 'Руководитель службы инсталляции', quantity: 1 },
]

const taskTitles = [
  'Подписание Акта ввода в эксплуатацию',
  'Список затраченных материалов',
  'Тестирование комплекса систем телемедицины (MVS VEGA)',
  'Проведение инструктажа и передача инструкций мед персоналу',
  'Пуско-наладочные работы',
  'Инсталляция оконечного оборудования',
  'Предоставить карту сети',
  'Монтаж кабеленесущих систем',
  'Осмотр объекта',
]

const process = (startM: number, startD: number, endM: number, endD: number, id: number, offset: number): DtoDetailedProcess => ({
  id,
  title: 'Инсталляция',
  project_id: id,
  start_date: iso(day(startM, startD)),
  end_date: iso(day(endM, endD)),
  milestones: [
    { id: id * 100 + 1, title: 'Согласование сметы', content: 'Утверждение сметной документации заказчиком', date: iso(day(startM, startD + 4)) },
    { id: id * 100 + 2, title: 'Поставка материалов', content: 'Приёмка партии на склад', date: iso(day(startM, startD + 12)) },
    { id: id * 100 + 3, title: 'Окончание работ', content: 'Финал работ на объекте, подготовка к приёмке', date: iso(day(endM, Math.min(endD - 3, 28))) },
  ],
  tasks: taskTitles.map((title, i) => {
    const res = resources[(i % 5)]
    return {
      id: i + 1 + offset,
      title,
      process_id: id,
      start_date: iso(day(startM, startD + i * 2)),
      end_date: iso(day(startM, startD + i * 2 + 5)),
      resources: [{ id: res.id, assignment_id: i + 1 + offset, code: res.code, title: res.title, quantity: (i % 3) + 1 }],
    }
  }),
})

const meta: Meta<typeof TaskPlanning> = {
  title: 'Components/Planner/TaskPlanning',
  component: TaskPlanning,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const SingleProject: Story = {
  args: {
    processes: [process(7, 15, 8, 22, 1, 0)],
    resources,
    origin: '2026-07-01',
  },
}

export const MultipleProjects: Story = {
  args: {
    processes: [
      process(7, 15, 8, 22, 1, 0),
      process(8, 5, 9, 18, 2, 100),
    ],
    resources,
    origin: '2026-07-01',
  },
}

/** Decades — processes stretch across several decades */
export const YearDecades: Story = {
  args: {
    processes: [
      process(1, 5, 3, 20, 1, 0),
      process(2, 10, 5, 25, 2, 100),
    ],
    resources,
    origin: '2026-01-01',
    unit: 'decade',
  },
}

/**
 * The side panel is exactly one number wide: `LABEL_WIDTH` (planner/layout.ts)
 * drives every layer of it — the corner cell, the row and merged labels, the
 * resource codes and the group divider, which reads it through the
 * `--label-width` custom property. The guard is deliberate: these layers used to
 * repeat `180px` in their own styles, so changing the constant moved only some
 * of them and the panel split at the seams.
 */
export const LabelColumnLayers: Story = {
  tags: ['vitest'],
  args: {
    processes: [
      process(7, 15, 8, 22, 1, 0),
      process(8, 5, 9, 18, 2, 100),
    ],
    resources,
    origin: '2026-07-01',
  },
  play: async ({ canvasElement, step }) => {
    await new Promise((r) => setTimeout(r, 60))

    await step('every side-panel layer is LABEL_WIDTH wide', () => {
      const layers = Array.from(
        canvasElement.querySelectorAll<HTMLElement>('.th-corner, .rs-labels, .gg-merged, .gg-label'),
      )
      // corner + resource codes + at least one group label
      expect(layers.length).toBeGreaterThan(2)
      for (const layer of layers) {
        const width = Math.round(layer.getBoundingClientRect().width)
        expect(width, `${layer.className} is ${width}px wide`).toBe(LABEL_WIDTH)
      }
    })

    await step('the group divider starts where the side panel ends', () => {
      const groups = Array.from(canvasElement.querySelectorAll<HTMLElement>('.gg-group'))
      expect(groups.length).toBeGreaterThan(0)
      for (const group of groups) {
        expect(getComputedStyle(group, '::after').left).toBe(`${LABEL_WIDTH}px`)
      }
    })

    await step('the corner and the label column share one right edge', () => {
      const corner = canvasElement.querySelector<HTMLElement>('.th-corner')
      const label = canvasElement.querySelector<HTMLElement>('.gg-merged, .gg-label')
      expect(corner).toBeTruthy()
      expect(label).toBeTruthy()
      expect(Math.round(corner!.getBoundingClientRect().right)).toBe(
        Math.round(label!.getBoundingClientRect().right),
      )
    })
  },
}
